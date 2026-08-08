/**
 * Fase 1B: reactivación de leads inactivos.
 *
 * Reutiliza la memoria de conversación ya guardada (ConversationSlot) y los
 * MessagingAdapter existentes por canal — sin infraestructura nueva más
 * allá de un job de BullMQ y dos campos nuevos en Lead.
 */
import type { ChatChannel, GlmAdapter, MessagingAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { withTenant } from '../config/tenant-context.js';
import { getReplyAddressFromConversation, sendWithRetry } from './chatbot.service.js';

export interface ReengagementCandidate {
  leadId: string;
  conversationId: string;
  channel: ChatChannel;
  externalId: string;
}

const INACTIVITY_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Un lead candidato: status temprano del funnel, sin showing agendado,
 * nunca remarketeado, no optó por no ser contactado, y su conversación
 * más reciente no tiene mensajes en los últimos 14 días. No hay un campo
 * denormalizado de "último mensaje", así que se calcula por lead.
 */
export async function findReengagementCandidates(tenantId: string): Promise<ReengagementCandidate[]> {
  return withTenant(prisma, tenantId, async (tx) => {
    const threshold = new Date(Date.now() - INACTIVITY_THRESHOLD_MS);
    const leads = await tx.lead.findMany({
      where: {
        tenantId,
        status: { in: ['new_', 'contacted', 'qualified'] },
        showings: { none: {} },
        lastRemarketedAt: null,
        optedOutAt: null,
      },
      include: {
        conversations: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          include: {
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });

    const candidates: ReengagementCandidate[] = [];
    for (const lead of leads) {
      const conversation = lead.conversations[0];
      const lastMessage = conversation?.messages[0];
      if (!conversation || !lastMessage) continue;
      if (lastMessage.createdAt >= threshold) continue;
      candidates.push({
        leadId: lead.id,
        conversationId: conversation.id,
        channel: conversation.channel as ChatChannel,
        externalId: conversation.externalId,
      });
    }
    return candidates;
  });
}

const DRAFT_SYSTEM_PROMPT = `Eres un asistente de bienes raíces amable y profesional. Redacta un mensaje corto (1-2 líneas) para retomar contacto con un prospecto que dejó de responder hace un tiempo. No suenes a marketing masivo ni a plantilla genérica. Si el perfil incluye área, presupuesto, o tipo de unidad, menciónalos brevemente para mostrar que recuerdas la conversación. Si el perfil está vacío, pregunta qué está buscando. Responde solo con el texto del mensaje, sin comillas ni formato adicional.`;

export async function draftReengagementMessage(
  glm: GlmAdapter,
  slots: Record<string, string>,
): Promise<string> {
  const response = await glm.reason({
    systemPrompt: DRAFT_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({ capturedProfile: slots }),
    temperature: 0.4,
  });
  return response.content.trim();
}

/**
 * Envía el mensaje de reactivación y registra el resultado. Si falla, NO
 * marca lastRemarketedAt — el lead sigue elegible y se reintenta la
 * siguiente corrida semanal del job, sin lógica de reintento especial.
 */
export async function sendReengagementMessage(
  messaging: MessagingAdapter,
  candidate: ReengagementCandidate,
  content: string,
): Promise<boolean> {
  const assistantMessage = await prisma.chatMessage.create({
    data: {
      conversationId: candidate.conversationId,
      role: 'assistant',
      content,
      deliveryStatus: 'pending',
    },
  });

  try {
    const to = getReplyAddressFromConversation(candidate.externalId);
    const result = await sendWithRetry(() => messaging.send({ to, body: content, channel: candidate.channel }));
    await prisma.$transaction([
      prisma.chatMessage.update({
        where: { id: assistantMessage.id },
        data: {
          deliveryStatus: 'sent',
          providerMessageIds: [result.messageId],
        },
      }),
      prisma.lead.update({
        where: { id: candidate.leadId },
        data: { lastRemarketedAt: new Date() },
      }),
    ]);
    return true;
  } catch (error) {
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        deliveryStatus: 'failed',
        deliveryError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error',
        deliveryAttempts: 1,
      },
    });
    return false;
  }
}

/**
 * Orquesta un ciclo completo de reactivación para un tenant: busca
 * candidatos, redacta y envía un mensaje a cada uno secuencialmente (no
 * en paralelo, para no ráfaguear al proveedor de mensajería).
 */
export async function runWeeklyReengagement(
  tenantId: string,
  deps: { glm: GlmAdapter; messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<{ sent: number; skipped: number }> {
  const candidates = await findReengagementCandidates(tenantId);
  let sent = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const messaging = deps.messaging[candidate.channel];
    if (!messaging) {
      skipped++;
      continue;
    }
    // Un candidato que falla (ej. GLM caído) no debe tumbar la corrida
    // completa — se salta y se reintenta la próxima semana, igual que un
    // fallo de envío (ver sendReengagementMessage).
    try {
      const slots = await prisma.conversationSlot.findMany({
        where: { conversationId: candidate.conversationId },
      });
      const slotMap = Object.fromEntries(slots.map((slot) => [slot.key, slot.value]));
      const content = await draftReengagementMessage(deps.glm, slotMap);
      const wasSent = await sendReengagementMessage(messaging, candidate, content);
      if (wasSent) sent++;
      else skipped++;
    } catch (error) {
      console.error(`[Remarketing] Candidato ${candidate.leadId} falló, se reintenta la próxima corrida:`, error);
      skipped++;
    }
  }

  return { sent, skipped };
}

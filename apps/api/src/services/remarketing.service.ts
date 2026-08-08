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
import { getReplyAddressFromConversation, looksLikeSpanish, sendWithRetry } from './chatbot.service.js';

export interface ReengagementCandidate {
  leadId: string;
  conversationId: string;
  channel: ChatChannel;
  externalId: string;
  /** Contenido del último mensaje del LEAD (role: 'user'), usado para adivinar el idioma del draft (Fix 4). */
  lastUserMessage?: string;
}

const INACTIVITY_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Un lead candidato: status temprano del funnel, sin showing agendado,
 * nunca remarketeado, no optó por no ser contactado, canal remarketeable
 * (ver el `if (conversation.channel === 'web') continue;` más abajo), y su
 * conversación más reciente no tiene mensajes DEL LEAD en los últimos 14
 * días.
 *
 * La ventana de inactividad se calcula sobre el último mensaje con
 * role: 'user' exclusivamente, no sobre el último mensaje de la
 * conversación sin importar el rol: un intento de remarketing propio
 * (sendReengagementMessage) crea un ChatMessage role: 'assistant' que, si
 * se considerara, se convertiría en el "último mensaje" y reiniciaría el
 * reloj de 14 días — bloqueando el reintento semanal del propio lead que
 * el diseño pide ("se reintenta la siguiente semana automáticamente").
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
            messages: { where: { role: 'user' }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });

    const candidates: ReengagementCandidate[] = [];
    for (const lead of leads) {
      const conversation = lead.conversations[0];
      const lastUserMessage = conversation?.messages[0];
      if (!conversation || !lastUserMessage) continue;
      if (lastUserMessage.createdAt >= threshold) continue;
      // Web chat es request/response sobre POST /chat/messages, sin
      // mecanismo de push real hacia la persona — el WebChatMockAdapter que
      // factory.ts conecta para 'web' es permanente (no hay adapter real
      // detrás), así que "enviar" ahí no entrega nada a nadie. Tratarlo como
      // canal remarketeable quemaría el único intento del lead
      // (lastRemarketedAt) sin que jamás reciba el mensaje. Se excluye aquí,
      // en un solo lugar, hasta que una tarea futura agregue un mecanismo de
      // push real para ese canal.
      if (conversation.channel === 'web') continue;
      candidates.push({
        leadId: lead.id,
        conversationId: conversation.id,
        channel: conversation.channel as ChatChannel,
        externalId: conversation.externalId,
        lastUserMessage: lastUserMessage.content,
      });
    }
    return candidates;
  });
}

const DRAFT_SYSTEM_PROMPT = `You are a friendly, professional real-estate assistant. Draft a short message (1-2 lines) to re-engage a prospect who stopped responding a while ago. Don't sound like mass marketing or a generic template. If the profile includes an area, budget, or unit type, mention it briefly to show you remember the conversation. If the profile is empty, ask what they're looking for. Reply with only the message text, no quotes or extra formatting.`;

const MAX_DRAFT_LENGTH = 320;

/**
 * Plantilla determinista usada cuando el GLM real no está disponible (mock)
 * o cuando su respuesta no sirve (vacía). Nunca debe enviarse texto del
 * placeholder del mock ('Simulated GLM agent response.') a un lead real —
 * eso, además de ser basura visible para la persona, quema su único intento
 * de remarketing (lastRemarketedAt) sin haber entregado nada útil.
 */
function buildFallbackDraft(slots: Record<string, string>, spanish: boolean): string {
  const area = slots.preferred_area;
  const budget = slots.budget;
  if (spanish) {
    const areaPart = area ? ` en ${area}` : '';
    const budgetPart = budget ? ` alrededor de $${budget}` : '';
    return `¡Hola! ¿Sigues buscando${areaPart}${budgetPart}? Cuéntame qué necesitas y te puedo ayudar.`;
  }
  const areaPart = area ? ` in ${area}` : '';
  const budgetPart = budget ? ` around $${budget}` : '';
  return `Hi! Are you still looking${areaPart}${budgetPart}? Let me know what you need and I can help.`;
}

/**
 * Único checkpoint antes de un envío automático sin revisión humana (por
 * diseño, Fase 1B no tiene cola de aprobación) — así que valida
 * defensivamente lo que sea que haya llegado (GLM real o fallback):
 * no vacío, longitud acotada (~320 chars, el prompt pide 1-2 líneas), y sin
 * una capa de comillas envolventes que el modelo a veces agrega a pesar de
 * que el prompt las prohíbe.
 */
function sanitizeDraft(content: string, slots: Record<string, string>, spanish: boolean): string {
  let text = content.trim();
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ];
  for (const [open, close] of quotePairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  if (!text) text = buildFallbackDraft(slots, spanish);
  if (text.length > MAX_DRAFT_LENGTH) {
    const truncated = text.slice(0, MAX_DRAFT_LENGTH);
    const lastSpace = truncated.lastIndexOf(' ');
    text = (lastSpace > MAX_DRAFT_LENGTH * 0.6 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + '…';
  }
  return text;
}

/**
 * Redacta el mensaje de reactivación. `isMockGlm` viene del mismo mecanismo
 * que `getAdapters().mockModes.glm` ya expone en el resto del código base
 * (ver factory.ts) — cuando GLM no está configurado, GlmMockAdapter.reason()
 * devuelve el string fijo 'Simulated GLM agent response.' (ninguna rama de
 * su esquema simulado matchea esta forma de request), y ese texto NO debe
 * llegar jamás a un lead real. En vez de detectar el contenido (frágil, y
 * un lead real bien podría escribir algo parecido por casualidad), se usa
 * un flag explícito que el caller ya tiene disponible — mismo patrón que
 * isIntegrationConfigured/mockModes.
 */
export async function draftReengagementMessage(
  glm: GlmAdapter,
  slots: Record<string, string>,
  options: { isMockGlm: boolean; lastUserMessage?: string } = { isMockGlm: false },
): Promise<string> {
  const spanish = looksLikeSpanish(options.lastUserMessage);
  if (options.isMockGlm) {
    return sanitizeDraft(buildFallbackDraft(slots, spanish), slots, spanish);
  }
  const response = await glm.reason({
    systemPrompt: DRAFT_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({ capturedProfile: slots, replyLanguage: spanish ? 'Spanish' : 'English' }),
    temperature: 0.4,
  });
  return sanitizeDraft(response.content, slots, spanish);
}

/**
 * Cierra el loop con detectOptOutPhrase (Fix 6/8): un mensaje proactivo y
 * automatizado como este necesita una forma explícita y documentada de que
 * el lead pida no recibir más — texto exacto y determinista (no generado
 * por GLM) por razones de compliance, para que siempre esté presente sin
 * depender de que el modelo decida incluirlo.
 */
function withOptOutInstruction(content: string, spanish: boolean): string {
  const instruction = spanish
    ? 'Responde ALTO para dejar de recibir mensajes como este.'
    : 'Reply STOP to stop receiving messages like this.';
  return `${content}\n\n${instruction}`;
}

/**
 * Envía el mensaje de reactivación y registra el resultado. Si falla, NO
 * marca lastRemarketedAt — el lead sigue elegible y se reintenta la
 * siguiente corrida semanal del job, sin lógica de reintento especial.
 */
export async function sendReengagementMessage(
  messaging: MessagingAdapter,
  candidate: ReengagementCandidate,
  draftContent: string,
): Promise<boolean> {
  const content = withOptOutInstruction(draftContent, looksLikeSpanish(candidate.lastUserMessage));
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
  deps: { glm: GlmAdapter; messaging: Record<ChatChannel, MessagingAdapter>; isMockGlm?: boolean },
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
      const content = await draftReengagementMessage(deps.glm, slotMap, {
        isMockGlm: deps.isMockGlm ?? false,
        lastUserMessage: candidate.lastUserMessage,
      });
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

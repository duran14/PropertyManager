/**
 * Chatbot omnicanal con FSM conversacional.
 *
 * Diferencias clave vs la versión anterior:
 *  1. Usa GLM con responseSchema → el modelo devuelve JSON estructurado
 *     {intent, reply, slots, next_state} en vez de texto libre.
 *  2. Pasa el historial completo de la conversación (no solo el último mensaje).
 *  3. Recolecta slots (budget, move-in date, occupants, pets) que alimentan
 *     la propuesta de unidades y el agendamiento.
 *  4. Es canal-agnóstico: funciona igual por WhatsApp, Telegram o web chat.
 *  5. Cuando llega a 'scheduling', deriva a ShowMojo (Fase 10).
 *
 * Estados del FSM:
 *  greeting → collecting_budget → collecting_movein → proposing_units
 *           → proposing_tour → scheduling → handoff
 */
import type { GlmAdapter, MessagingAdapter, ShowMojoAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';
import { getAvailableSlots, scheduleTour } from './scheduling.service.js';

export type ConversationState =
  | 'greeting'
  | 'collecting_budget'
  | 'collecting_movein'
  | 'proposing_units'
  | 'proposing_tour'
  | 'scheduling'
  | 'handoff';

export interface InboundChatMessage {
  tenantId: string;
  from: string; // teléfono, chat id, o session id
  body: string;
  channel: 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email';
  mediaUrls?: string[];
}

export interface BotReply {
  replyText: string;
  newState: ConversationState;
  leadCreated: boolean;
  handoff: boolean;
  /** Slots recolectados en este turno. */
  extractedSlots?: Record<string, string>;
  /** Unidades propuestas (si aplica). */
  proposedUnits?: Array<{ id: string; name: string; rent: number }>;
}

/**
 * Procesa un mensaje entrante y genera la respuesta del bot.
 */
export async function handleInboundMessage(
  input: InboundChatMessage,
  deps: { glm: GlmAdapter; messaging: MessagingAdapter; showmojo: ShowMojoAdapter },
): Promise<BotReply> {
  // 1. Recuperar o crear conversación.
  const conversation = await prisma.chatConversation.upsert({
    where: {
      tenantId_externalId: { tenantId: input.tenantId, externalId: input.from },
    },
    update: { channel: input.channel },
    create: {
      tenantId: input.tenantId,
      externalId: input.from,
      channel: input.channel,
      state: 'greeting',
    },
    include: {
      messages: { orderBy: { createdAt: 'asc' }, take: 20 },
      slots: true,
    },
  });

  // 2. Guardar el mensaje del usuario.
  await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: input.body,
      mediaUrls: input.mediaUrls ?? [],
    },
  });

  // 3. Cargar contexto: slots existentes + unidades disponibles.
  const existingSlots: Record<string, string> = {};
  for (const s of conversation.slots) {
    existingSlots[s.key] = s.value;
  }
  const availableUnits = await getAvailableUnits(input.tenantId, existingSlots);
  const currentState = conversation.state as ConversationState;

  // 4. Llamar a GLM con el historial completo y responseSchema estructurado.
  const glmResult = await callGlm(deps.glm, {
    currentState,
    userMessage: input.body,
    history: conversation.messages.map((m) => ({ role: m.role, content: m.content })),
    existingSlots,
    availableUnits,
  });

  // 5. Persistir slots extraídos.
  if (glmResult.slots) {
    for (const [key, value] of Object.entries(glmResult.slots)) {
      if (value) {
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key } },
          update: { value },
          create: { conversationId: conversation.id, key, value },
        });
      }
    }
  }

  // 6. Actualizar estado de la conversación.
  let newState = glmResult.next_state ?? currentState;
  let finalReply = glmResult.reply;

  // === Lógica de scheduling integrada con ShowMojo ===
  // Si entramos en scheduling, presentamos los slots disponibles.
  // Si ya estábamos en scheduling y el usuario eligió un número, agendamos.
  if (newState === 'scheduling' && currentState !== 'scheduling') {
    // Primera vez en scheduling: obtener y presentar slots.
    const unitId = conversation.unitId ?? (await inferUnitFromSlots(input.tenantId, existingSlots));
    if (unitId) {
      const slotsResult = await getAvailableSlots(input.tenantId, unitId, deps.showmojo);
      if (slotsResult.slots.length > 0) {
        // Guardar los slots en la conversación para referencia.
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key: 'pending_slots' } },
          update: { value: JSON.stringify(slotsResult.slots) },
          create: { conversationId: conversation.id, key: 'pending_slots', value: JSON.stringify(slotsResult.slots) },
        });
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key: 'scheduling_unit_id' } },
          update: { value: unitId },
          create: { conversationId: conversation.id, key: 'scheduling_unit_id', value: unitId },
        });

        const slotsText = slotsResult.slots
          .map((s) => `${s.index + 1}. ${s.label}`)
          .join('\n');
        finalReply =
          `¡Perfecto! Estos son los horarios disponibles para visitar la propiedad:\n\n` +
          `${slotsText}\n\n` +
          `Responde con el número de la opción que prefieras (1-${slotsResult.slots.length}).`;
      }
    }
  } else if (currentState === 'scheduling') {
    // Ya estábamos en scheduling: ¿el usuario eligió un número?
    const slotChoice = parseInt(input.body.trim(), 10);
    const pendingSlotsRaw = existingSlots['pending_slots'];
    const schedulingUnitId = existingSlots['scheduling_unit_id'];

    if (!isNaN(slotChoice) && pendingSlotsRaw && schedulingUnitId) {
      const pendingSlots = JSON.parse(pendingSlotsRaw) as Array<{
        index: number;
        startAt: string;
        endAt: string;
        brokerName?: string;
      }>;
      const chosen = pendingSlots.find((s) => s.index === slotChoice - 1);
      if (chosen) {
        // Obtener el lead de esta conversación.
        const lead = await prisma.lead.findFirst({
          where: { phone: input.from },
        });
        if (lead) {
          try {
            const result = await scheduleTour({
              tenantId: input.tenantId,
              unitId: schedulingUnitId,
              leadId: lead.id,
              slotIndex: chosen.index,
              prospectName: lead.name ?? lead.phone ?? 'Prospecto',
              prospectPhone: lead.phone ?? undefined,
              prospectEmail: lead.email ?? undefined,
              conversationId: conversation.id,
              adapter: deps.showmojo,
            });
            finalReply =
              `¡Visita agendada! 🗓️\n\n` +
              `${new Date(result.scheduledAt).toLocaleDateString('en-CA', {
                weekday: 'long', month: 'long', day: 'numeric',
              })} a las ${new Date(result.scheduledAt).toLocaleTimeString('en-CA', {
                hour: 'numeric', minute: '2-digit', hour12: true,
              })}\n\n` +
              `El broker confirmará la disponibilidad en breve. ¿Te envío la confirmación por aquí o prefieres otro canal?`;
            newState = 'handoff'; // visita agendada, fin del funnel del bot.
          } catch (err) {
            finalReply = 'Hubo un problema al agendar la visita. ¿Probamos con otro horario?';
            newState = 'scheduling';
          }
        }
      }
    }
  }

  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { state: newState },
  });

  // 7. Guardar respuesta del bot.
  await prisma.chatMessage.create({
    data: { conversationId: conversation.id, role: 'assistant', content: finalReply },
  });

  // 8. Crear/actualizar Lead.
  const leadCreated = await ensureLead(input.tenantId, conversation.id, input.from, input.body, input.channel);

  // 9. Enviar respuesta por el canal correspondiente.
  await deps.messaging.send({
    to: input.from,
    body: finalReply,
    channel: input.channel,
  });

  // 10. Auditoría.
  await writeAudit({
    tenantId: input.tenantId,
    actorId: 'chatbot_agent',
    actorType: 'ai_agent',
    action: 'chatbot.message_handled',
    entityType: 'chat_conversation',
    entityId: conversation.id,
    payload: {
      from: input.from,
      channel: input.channel,
      newState,
      handoff: newState === 'handoff',
      leadCreated,
      slots: glmResult.slots,
    },
  });

  return {
    replyText: finalReply,
    newState,
    leadCreated,
    handoff: newState === 'handoff',
    extractedSlots: glmResult.slots,
    proposedUnits: newState === 'proposing_tour' ? availableUnits.slice(0, 3).map((u) => ({
      id: u.id,
      name: u.name,
      rent: u.rentCents,
    })) : undefined,
  };
}

/**
 * Llama a GLM con un prompt estructurado y responseSchema.
 * El modelo devuelve JSON con: intent, reply, slots extraídos, próximo estado.
 */
async function callGlm(
  glm: GlmAdapter,
  ctx: {
    currentState: ConversationState;
    userMessage: string;
    history: Array<{ role: string; content: string }>;
    existingSlots: Record<string, string>;
    availableUnits: Array<{ id: string; name: string; rentCents: number; city: string; beds?: string }>;
  },
): Promise<{
  reply: string;
  slots?: Record<string, string>;
  next_state?: ConversationState;
}> {
  const systemPrompt = buildSystemPrompt(ctx.currentState, ctx.availableUnits, ctx.existingSlots);
  const historyText = ctx.history
    .slice(-10) // últimos 10 turnos para no exceder contexto
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  try {
    const res = await glm.reason({
      systemPrompt,
      userPrompt: `Historial:\n${historyText}\n\nMensaje actual del usuario: ${ctx.userMessage}`,
      responseSchema: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'Respuesta del bot al usuario (máx 2-3 frases)' },
          slots: {
            type: 'object',
            description: 'Información extraída del mensaje (budget, move_in_date, occupants, pets, etc.)',
            properties: {
              budget: { type: 'string' },
              move_in_date: { type: 'string' },
              occupants: { type: 'string' },
              pets: { type: 'string' },
              preferred_area: { type: 'string' },
            },
          },
          next_state: {
            type: 'string',
            enum: ['greeting', 'collecting_budget', 'collecting_movein', 'proposing_units', 'proposing_tour', 'scheduling', 'handoff'],
          },
        },
        required: ['reply', 'next_state'],
      },
      temperature: 0.7,
    });

    const parsed = JSON.parse(res.content) as {
      reply: string;
      slots?: Record<string, string>;
      next_state?: ConversationState;
    };
    return {
      reply: parsed.reply ?? '¿En qué más puedo ayudarte?',
      slots: parsed.slots,
      next_state: parsed.next_state,
    };
  } catch {
    // Fallback: si GLM falla o no devuelve JSON válido, respuesta genérica.
    return {
      reply: 'Gracias por tu mensaje. ¿Podrías decirme cuál es tu presupuesto mensual y cuándo te gustaría mudarte?',
      next_state: ctx.currentState === 'greeting' ? 'collecting_budget' : ctx.currentState,
    };
  }
}

function buildSystemPrompt(
  state: ConversationState,
  availableUnits: Array<{ id: string; name: string; rentCents: number; city: string }>,
  slots: Record<string, string>,
): string {
  const unitsText = availableUnits.length > 0
    ? availableUnits.map((u) => `- ${u.name} en ${u.city}: $${(u.rentCents / 100).toFixed(0)}/mes`).join('\n')
    : 'No hay unidades disponibles actualmente.';

  const slotsText = Object.keys(slots).length > 0
    ? '\nInformación ya conocida del usuario:\n' + Object.entries(slots).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : '';

  return [
    'Eres el asistente virtual de una empresa de Property Management en British Columbia, Canadá.',
    'Atiendes consultas de personas interesadas en alquilar propiedades.',
    'Responde de forma amable, concisa y profesional. Máximo 2-3 frases por mensaje.',
    'NO des información legal ni financiera — deriva esas consultas a un humano.',
    'Tu objetivo es calificar al prospecto y agendar una visita a la propiedad.',
    '',
    `Estado actual de la conversación: ${state}`,
    'Estados del funnel: greeting → collecting_budget → collecting_movein → proposing_units → proposing_tour → scheduling → handoff',
    '- greeting: saludo inicial, preguntar qué busca',
    '- collecting_budget: preguntar presupuesto mensual',
    '- collecting_movein: preguntar fecha de mudanza',
    '- proposing_units: sugerir unidades que coincidan',
    '- proposing_tour: ofrecer agendar una visita',
    '- scheduling: derivar a agendamiento (ShowMojo)',
    '- handoff: pasar a humano (consulta fuera de alcance)',
    '',
    'Unidades disponibles:',
    unitsText,
    slotsText,
    '',
    'Responde en JSON con: reply (tu mensaje), slots (info extraída), next_state (próximo estado).',
  ].join('\n');
}

/**
 * Obtiene unidades disponibles, filtrando por budget si se conoce.
 */
async function getAvailableUnits(
  tenantId: string,
  slots: Record<string, string>,
): Promise<Array<{ id: string; name: string; rentCents: number; city: string }>> {
  const budget = slots.budget ? parseInt(slots.budget.replace(/[^0-9]/g, '')) * 100 : undefined;
  const units = await prisma.unit.findMany({
    where: {
      tenantId,
      isActive: true,
      ...(budget ? { rentCents: { lte: budget } } : {}),
    },
    include: { property: { select: { city: true } } },
    take: 5,
  });
  return units.map((u) => ({
    id: u.id,
    name: u.name,
    rentCents: u.rentCents,
    city: u.property.city,
  }));
}

/**
 * Infiere qué unidad quiere visitar el prospecto cuando no hay unitId en la conversación.
 * Toma la primera unidad disponible que cumpla el budget.
 */
async function inferUnitFromSlots(
  tenantId: string,
  slots: Record<string, string>,
): Promise<string | null> {
  const units = await getAvailableUnits(tenantId, slots);
  return units[0]?.id ?? null;
}

/** Crea un Lead si no existe (de-duplicación por teléfono). */
async function ensureLead(
  tenantId: string,
  conversationId: string,
  fromPhone: string,
  firstMessage: string,
  channel: string,
): Promise<boolean> {
  const existing = await prisma.lead.findFirst({
    where: { tenantId, phone: fromPhone },
  });
  if (existing) {
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { leadId: existing.id },
    });
    return false;
  }

  const lead = await prisma.lead.create({
    data: {
      tenantId,
      phone: fromPhone,
      message: firstMessage.slice(0, 500),
      source: channel === 'telegram' ? 'telegram' : channel === 'web' ? 'web' : channel === 'email' ? 'email' : 'whatsapp',
      status: 'new_',
      preferredChannel: channel,
    },
  });
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { leadId: lead.id },
  });
  return true;
}

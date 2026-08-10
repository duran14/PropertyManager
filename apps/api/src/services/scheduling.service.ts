/**
 * Scheduling service connecting the chatbot to Google Calendar.
 */
import { Prisma } from '@prisma/client';
import { computeAvailableSlots } from '@property-manager/core';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { writeAudit } from './audit.service.js';
import { createConversationEvent } from './conversation-events.service.js';
import { getUsableAccessToken, tenantOwnerKey } from './calendar-connection.service.js';
import { getSchedulingConfig } from './scheduling-config.service.js';

export function normalizeShowingDuration(durationMinutes: number | undefined): number {
  const duration = durationMinutes ?? 30;
  if (![15, 30, 45, 60].includes(duration)) {
    throw new Error('Showing duration must be 15, 30, 45, or 60 minutes');
  }
  return duration;
}

export function canConfirmShowingStatus(status: string): boolean {
  return status === 'scheduled';
}

export function canCancelShowingStatus(status: string): boolean {
  return status === 'scheduled' || status === 'confirmed';
}

export function buildShowingConfirmationEmail(input: {
  prospectName: string;
  propertyLabel: string;
  address: string;
  scheduledAt: Date;
}): string {
  const scheduledDate = input.scheduledAt.toLocaleString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `Hello ${input.prospectName},\n\nYour property tour is confirmed.\n\n${input.propertyLabel}\n${input.address}\n${scheduledDate}\n\nWe look forward to seeing you.`;
}

export async function sendShowingConfirmationEmail(input: {
  recipient: string;
  body: string;
  send: (message: { to: string; body: string; channel: 'email'; subject: string }) => Promise<{ messageId: string }>;
}): Promise<{ messageId: string }> {
  return input.send({
    to: input.recipient,
    body: input.body,
    channel: 'email',
    subject: 'Your property tour is confirmed',
  });
}

function showingSlotKey(leadId: string, scheduledAt: Date | string): string {
  return `${leadId}:${new Date(scheduledAt).toISOString()}`;
}

export function buildProspectSlotKey(
  input: { leadId: string; email?: string | null; phone?: string | null },
  scheduledAt: Date | string,
): string {
  const email = input.email?.trim().toLowerCase();
  const phone = input.phone?.replace(/\D/g, '');
  const prospectIdentity = email
    ? `email:${email}`
    : phone
      ? `phone:${phone}`
      : `lead:${input.leadId}`;
  return `${prospectIdentity}:${new Date(scheduledAt).toISOString()}`;
}

/**
 * Etiqueta legible del hueco, formateada EN LA ZONA DE LA CONFIGURACIÓN.
 * Formatear en la del servidor le diría al prospecto la hora equivocada
 * en cuanto la API corra en UTC.
 */
export function formatSlotLabel(input: { startAt: string; timeZone: string }): string {
  const start = new Date(input.startAt);
  const day = start.toLocaleDateString('en-CA', {
    timeZone: input.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = start.toLocaleTimeString('en-CA', {
    timeZone: input.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${day} at ${time}`;
}

export interface AvailableSlot {
  index: number;
  startAt: string;
  endAt: string;
  label: string;
}

export type SchedulingAvailabilityResult =
  | { ok: true; slots: AvailableSlot[] }
  | {
    ok: false;
    reason: 'not_connected' | 'revoked' | 'provider_error' | 'no_slots' | 'unit_not_found';
  };

/** Cuántas opciones caben en un mensaje de chat sin abrumar. */
const MAX_OFFERED_SLOTS = 6;

export async function getSchedulingAvailability(
  tenantId: string,
  unitId: string,
): Promise<SchedulingAvailabilityResult> {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, tenantId } });
  if (!unit) return { ok: false, reason: 'unit_not_found' };

  const token = await getUsableAccessToken(tenantId);
  if (!token.ok) return { ok: false, reason: token.reason };

  const config = await getSchedulingConfig(tenantId);
  const now = Date.now();
  const from = new Date(now + config.minNoticeHours * 60 * 60_000);
  const to = new Date(now + config.maxAdvanceDays * 24 * 60 * 60_000);

  const { getAdapters } = await import('../config/adapters.js');
  let busy;
  try {
    busy = await getAdapters().calendar.getBusy({
      accessToken: token.accessToken,
      // Los dos: el principal y el nuestro. Sin el nuestro, el bot ofrecería
      // un horario donde ya hay otro showing.
      calendarIds: ['primary', token.connection.showingsCalendarId],
      from: from.toISOString(),
      to: to.toISOString(),
    });
  } catch {
    return { ok: false, reason: 'provider_error' };
  }

  const slots = computeAvailableSlots({
    from,
    to,
    weeklyHours: config.weeklyHours,
    busy: busy.map((interval) => ({
      start: new Date(interval.startAt),
      end: new Date(interval.endAt),
    })),
    timeZone: config.timeZone,
    durationMinutes: config.showingDurationMinutes,
    bufferMinutes: config.bufferMinutes,
    granularityMinutes: config.slotGranularityMinutes,
  });

  if (slots.length === 0) return { ok: false, reason: 'no_slots' };

  return {
    ok: true,
    slots: slots.slice(0, MAX_OFFERED_SLOTS).map((slot, index) => ({
      index,
      startAt: slot.start.toISOString(),
      endAt: slot.end.toISOString(),
      label: formatSlotLabel({ startAt: slot.start.toISOString(), timeZone: config.timeZone }),
    })),
  };
}

export interface BookShowingInput {
  tenantId: string;
  unitId: string;
  leadId: string;
  startAt: Date;
  prospectName: string;
  prospectEmail?: string;
  prospectPhone?: string;
  conversationId?: string;
}

export type BookShowingResult =
  | { ok: true; showingId: string; scheduledAt: string; googleEventId: string }
  | { ok: false; status: 404; error: 'unit_not_found' | 'lead_not_found' }
  | {
    ok: false;
    status: 409;
    error: 'slot_taken' | 'slot_no_longer_offered' | 'prospect_double_booked';
  }
  | { ok: false; status: 503; error: 'calendar_unavailable' };

export async function bookShowingFromCalendar(
  input: BookShowingInput,
): Promise<BookShowingResult> {
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, tenantId: input.tenantId },
  });
  if (!lead) return { ok: false, status: 404, error: 'lead_not_found' };

  const unit = await prisma.unit.findFirst({
    where: { id: input.unitId, tenantId: input.tenantId },
    include: { property: true },
  });
  if (!unit) return { ok: false, status: 404, error: 'unit_not_found' };

  // Se recalcula a propósito: los pending_slots guardados en la conversación
  // pueden tener media hora de viejos.
  const availability = await getSchedulingAvailability(input.tenantId, input.unitId);
  if (!availability.ok) {
    return availability.reason === 'no_slots'
      ? { ok: false, status: 409, error: 'slot_no_longer_offered' }
      : { ok: false, status: 503, error: 'calendar_unavailable' };
  }
  const startIso = input.startAt.toISOString();
  const chosen = availability.slots.find((slot) => slot.startAt === startIso);
  if (!chosen) return { ok: false, status: 409, error: 'slot_no_longer_offered' };

  const token = await getUsableAccessToken(input.tenantId);
  if (!token.ok) return { ok: false, status: 503, error: 'calendar_unavailable' };

  const config = await getSchedulingConfig(input.tenantId);
  const calendarSlotKey = `${token.connection.ownerKey}:${startIso}`;

  // Estado previo del Lead/Conversation, para poder revertirlos si el evento
  // de Google falla DESPUÉS de que la transacción de abajo ya los tocó. Sin
  // esto, un booking fallido deja al lead marcado tour_scheduled para
  // siempre — la misma mentira que la compensación del Showing existe para
  // evitar, una tabla más allá.
  const previousLeadStatus = lead.status;
  const previousLeadUnitId = lead.unitId;
  const previousConversationUnitId = input.conversationId
    ? (await prisma.chatConversation.findFirst({
      where: { id: input.conversationId, tenantId: input.tenantId },
      select: { unitId: true },
    }))?.unitId ?? null
    : null;

  // Primero la base: el INSERT es el paso que reserva el hueco de forma
  // atómica. Al revés, dos reservas simultáneas crearían ambas su evento
  // antes de chocar entre sí.
  let showingId: string;
  try {
    showingId = await prisma.$transaction(async (tx) => {
      const showing = await tx.showing.create({
        data: {
          tenantId: input.tenantId,
          leadId: input.leadId,
          unitId: input.unitId,
          scheduledAt: input.startAt,
          durationMinutes: config.showingDurationMinutes,
          status: 'scheduled',
          calendarSlotKey,
          activeSlotKey: `${input.leadId}:${startIso}`,
          activeProspectSlotKey: buildProspectSlotKey(
            { leadId: input.leadId, email: input.prospectEmail, phone: input.prospectPhone },
            input.startAt,
          ),
        },
      });
      await tx.lead.update({
        where: { id: input.leadId },
        data: { unitId: input.unitId, status: 'tour_scheduled' },
      });
      if (input.conversationId) {
        await tx.chatConversation.updateMany({
          where: { id: input.conversationId, tenantId: input.tenantId },
          data: { unitId: input.unitId },
        });
      }
      return showing.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'calendarSlotKey')) {
      return { ok: false, status: 409, error: 'slot_taken' };
    }
    if (isUniqueViolation(error, 'activeProspectSlotKey')
      || isUniqueViolation(error, 'activeSlotKey')) {
      return { ok: false, status: 409, error: 'prospect_double_booked' };
    }
    throw error;
  }

  const { getAdapters } = await import('../config/adapters.js');
  try {
    const event = await getAdapters().calendar.createEvent({
      accessToken: token.accessToken,
      calendarId: token.connection.showingsCalendarId,
      summary: `Showing — ${input.prospectName} — ${unit.property.name} · ${unit.name}`,
      description: [
        `Prospect: ${input.prospectName}`,
        input.prospectPhone ? `Phone: ${input.prospectPhone}` : null,
        input.prospectEmail ? `Email: ${input.prospectEmail}` : null,
        `Lead: ${getEnv().WEB_URL}/leads/${input.leadId}`,
      ].filter(Boolean).join('\n'),
      location: `${unit.property.address}, ${unit.property.city}, ${unit.property.province}`,
      startAt: startIso,
      endAt: chosen.endAt,
      timeZone: config.timeZone,
      attendeeEmails: input.prospectEmail ? [input.prospectEmail] : [],
    });

    await prisma.showing.update({
      where: { id: showingId },
      data: {
        googleEventId: event.eventId,
        googleCalendarId: token.connection.showingsCalendarId,
      },
    });

    await writeAudit({
      tenantId: input.tenantId,
      actorId: 'chatbot_agent',
      actorType: 'ai_agent',
      action: 'showing.scheduled',
      entityType: 'showing',
      entityId: showingId,
      payload: {
        leadId: input.leadId,
        unitId: input.unitId,
        scheduledAt: startIso,
        googleEventId: event.eventId,
      },
    });

    return { ok: true, showingId, scheduledAt: startIso, googleEventId: event.eventId };
  } catch (error) {
    // Compensación: un showing que no quedó bloqueado en ningún calendario
    // es exactamente la mentira que este sistema no puede contar. Tiene que
    // revertir TODO lo que la transacción de arriba tocó — Showing, Lead y
    // Conversation — no solo el Showing: un lead que se queda marcado
    // tour_scheduled sin tour es la misma mentira, una tabla más allá.
    await prisma.$transaction([
      prisma.showing.deleteMany({ where: { id: showingId } }),
      prisma.lead.updateMany({
        where: { id: input.leadId, tenantId: input.tenantId },
        data: { status: previousLeadStatus, unitId: previousLeadUnitId },
      }),
      ...(input.conversationId
        ? [prisma.chatConversation.updateMany({
          where: { id: input.conversationId, tenantId: input.tenantId },
          data: { unitId: previousConversationUnitId },
        })]
        : []),
    ]).catch(() => undefined);
    await writeAudit({
      tenantId: input.tenantId,
      actorId: 'scheduling_service',
      actorType: 'system',
      action: 'showing.calendar_event_failed',
      entityType: 'showing',
      entityId: showingId,
      payload: {
        leadId: input.leadId,
        scheduledAt: startIso,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    return { ok: false, status: 503, error: 'calendar_unavailable' };
  }
}

/** True solo si es P2002 y el índice violado incluye ese campo. */
function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}

export async function createManualShowingFromConversation(input: {
  tenantId: string;
  conversationId: string;
  scheduledAt: Date;
  durationMinutes?: number;
  actorId: string;
}) {
  const conversation = await prisma.chatConversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
    include: { lead: true, unit: true },
  });
  if (!conversation) throw new Error('Conversation not found');
  if (!conversation.leadId || !conversation.lead)
    throw new Error('Conversation has no linked lead');

  const leadId = conversation.leadId;
  const lead = conversation.lead;

  const unitId = conversation.unitId ?? lead.unitId;
  if (!unitId) throw new Error('Conversation has no recommended unit');

  const durationMinutes = normalizeShowingDuration(input.durationMinutes);
  // Se fija SIEMPRE, incluso si más abajo no se llega a crear el evento de
  // Google (o ni siquiera hay calendario conectado): sin esta llave, este
  // hueco es invisible para las dos redes de concurrencia a la vez —
  // getSchedulingAvailability no lo ve ocupado (no hay evento de Google que
  // reportar) y la unique de base no tiene nada con qué chocar — así que el
  // chatbot podría ofrecer y autoreservar el mismo horario encima. El modelo
  // de conexión hoy es siempre a nivel agencia (ownerKey null), igual que en
  // getUsableAccessToken.
  const calendarSlotKey = `${tenantOwnerKey(null)}:${input.scheduledAt.toISOString()}`;
  // IIFE en vez de `let showing` + try/catch envolviendo la asignación: así
  // TS sigue infiriendo el tipo de retorno de la transacción en vez de
  // ensanchar `showing` a `any` por falta de anotación.
  const showing = await (async () => {
    try {
      return await prisma.$transaction(async (tx) => {
        const dbShowing = await tx.showing.create({
          data: {
            tenantId: input.tenantId,
            leadId,
            unitId,
            scheduledAt: input.scheduledAt,
            durationMinutes,
            status: 'scheduled',
            calendarSlotKey,
            activeSlotKey: showingSlotKey(leadId, input.scheduledAt),
            activeProspectSlotKey: buildProspectSlotKey({
              leadId,
              email: lead.email,
              phone: lead.phone,
            }, input.scheduledAt),
          },
          include: {
            lead: { select: { name: true, phone: true, email: true } },
            unit: {
              select: { name: true, property: { select: { name: true, address: true, city: true } } },
            },
          },
        });

        await tx.lead.update({
          where: { id: leadId },
          data: { status: 'tour_scheduled' },
        });

        await tx.chatConversation.update({
          where: { id: conversation.id },
          data: { state: 'scheduling' },
        });

        return dbShowing;
      });
    } catch (error) {
      // `calendarSlotKey` es único POR TENANT, no por lead: un PM agendando a
      // mano a un instante que ya tiene CUALQUIER OTRO lead (en cualquier
      // unidad) choca esta unique. Sin este catch, el P2002 sube sin marcar
      // hasta el error handler global → 500 opaco, y en la UI el PM ve que no
      // pasó nada al hacer clic (Finding 2 de la revisión final). Se sigue la
      // misma convención de throw-tipado-que-la-ruta-mapea que ya usa esta
      // función para "Conversation not found" y compañía, en vez de inventar
      // un valor de retorno nuevo solo para este caso.
      if (isUniqueViolation(error, 'calendarSlotKey')) {
        throw new Error('slot_taken');
      }
      if (isUniqueViolation(error, 'activeProspectSlotKey') || isUniqueViolation(error, 'activeSlotKey')) {
        throw new Error('prospect_double_booked');
      }
      throw error;
    }
  })();

  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorType: 'user',
    action: 'showing.scheduled_manual',
    entityType: 'showing',
    entityId: showing.id,
    payload: {
      conversationId: input.conversationId,
      leadId: showing.leadId,
      unitId,
      scheduledAt: input.scheduledAt.toISOString(),
      durationMinutes,
    },
  });

  await createConversationEvent({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    leadId: showing.leadId,
    actorUserId: input.actorId,
    type: 'showing.scheduled',
    payload: {
      showingId: showing.id,
      unitId,
      scheduledAt: input.scheduledAt.toISOString(),
      durationMinutes,
    },
  });

  // Google Calendar: mejor esfuerzo, SIN compensación destructiva. A esta
  // función solo llega quien ya sabía (por la UI) que el hueco estaba libre,
  // así que un fallo de Google no debe borrar el showing — solo se audita y
  // la pantalla de Showings queda a cargo de mostrar la advertencia.
  const token = await getUsableAccessToken(input.tenantId);
  if (!token.ok) {
    await writeAudit({
      tenantId: input.tenantId,
      actorId: 'scheduling_service',
      actorType: 'system',
      action: 'showing.calendar_event_failed',
      entityType: 'showing',
      entityId: showing.id,
      payload: { leadId, scheduledAt: input.scheduledAt.toISOString(), error: `calendar_not_usable:${token.reason}` },
    });
    return showing;
  }

  try {
    const config = await getSchedulingConfig(input.tenantId);
    const endAt = new Date(input.scheduledAt.getTime() + durationMinutes * 60_000);
    const { getAdapters } = await import('../config/adapters.js');
    const event = await getAdapters().calendar.createEvent({
      accessToken: token.accessToken,
      calendarId: token.connection.showingsCalendarId,
      summary: `Showing — ${showing.lead.name ?? showing.lead.phone ?? 'Prospect'} — ${showing.unit?.property.name ?? ''} · ${showing.unit?.name ?? ''}`,
      description: [
        `Prospect: ${showing.lead.name ?? 'Unknown'}`,
        showing.lead.phone ? `Phone: ${showing.lead.phone}` : null,
        showing.lead.email ? `Email: ${showing.lead.email}` : null,
        `Lead: ${getEnv().WEB_URL}/leads/${leadId}`,
      ].filter(Boolean).join('\n'),
      location: showing.unit
        ? `${showing.unit.property.address}, ${showing.unit.property.city}`
        : undefined,
      startAt: input.scheduledAt.toISOString(),
      endAt: endAt.toISOString(),
      timeZone: config.timeZone,
      attendeeEmails: showing.lead.email ? [showing.lead.email] : [],
    });

    await prisma.showing.update({
      where: { id: showing.id },
      data: { googleEventId: event.eventId, googleCalendarId: token.connection.showingsCalendarId },
    });
  } catch (error) {
    await writeAudit({
      tenantId: input.tenantId,
      actorId: 'scheduling_service',
      actorType: 'system',
      action: 'showing.calendar_event_failed',
      entityType: 'showing',
      entityId: showing.id,
      payload: {
        leadId,
        scheduledAt: input.scheduledAt.toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }

  return showing;
}

export async function confirmShowing(
  showingId: string,
  tenantId: string,
  brokerUserId: string,
): Promise<void> {
  const { getAdapters } = await import('../config/adapters.js');
  const adapters = getAdapters();
  const showing = await prisma.showing.findFirst({
    where: { id: showingId, tenantId },
    include: {
      lead: { select: { name: true, email: true } },
      unit: { select: { name: true, property: { select: { name: true, address: true, city: true, province: true } } } },
    },
  });
  if (!showing) throw new Error('Showing not found');
  if (!canConfirmShowingStatus(showing.status))
    throw new Error(`Showing cannot be confirmed from status: ${showing.status}`);

  if (showing.showmojoId) {
    await adapters.showmojo.confirmShowing(showing.showmojoId);
  }

  await prisma.showing.update({
    where: { id: showingId },
    data: { status: 'confirmed', brokerUserId },
  });

  await writeAudit({
    tenantId,
    actorId: brokerUserId,
    actorType: 'user',
    action: 'showing.confirmed',
    entityType: 'showing',
    entityId: showingId,
    payload: { brokerUserId },
  });

  await createShowingConversationEvent({
    tenantId,
    showingId,
    leadId: showing.leadId,
    actorUserId: brokerUserId,
    type: 'showing.confirmed',
    scheduledAt: showing.scheduledAt,
  });

  if (showing.lead.email) {
    const propertyLabel = showing.unit
      ? `${showing.unit.property.name} — ${showing.unit.name}`
      : 'Your selected property';
    const address = showing.unit
      ? `${showing.unit.property.address}, ${showing.unit.property.city}, ${showing.unit.property.province}`
      : 'Address details are available from your property manager.';
    try {
      const delivery = await sendShowingConfirmationEmail({
        recipient: showing.lead.email,
        body: buildShowingConfirmationEmail({
          prospectName: showing.lead.name ?? 'there',
          propertyLabel,
          address,
          scheduledAt: showing.scheduledAt,
        }),
        send: (message) => adapters.messaging.email.send(message),
      });
      await writeAudit({
        tenantId,
        actorId: 'scheduling_service',
        actorType: 'system',
        action: 'showing.prospect_notified',
        entityType: 'showing',
        entityId: showingId,
        payload: { channel: 'email', providerMessageId: delivery.messageId },
      });
    } catch (error) {
      await writeAudit({
        tenantId,
        actorId: 'scheduling_service',
        actorType: 'system',
        action: 'showing.prospect_notification_failed',
        entityType: 'showing',
        entityId: showingId,
        payload: { channel: 'email', error: error instanceof Error ? error.message : 'Unknown error' },
      });
    }
  }
}

export async function cancelShowing(
  showingId: string,
  tenantId: string,
  userId: string,
  reason?: string,
): Promise<void> {
  const { getAdapters } = await import('../config/adapters.js');
  const adapters = getAdapters();
  const showing = await prisma.showing.findFirst({
    where: { id: showingId, tenantId },
  });
  if (!showing) throw new Error('Showing not found');
  if (!canCancelShowingStatus(showing.status))
    throw new Error(`Showing cannot be cancelled from status: ${showing.status}`);

  if (showing.showmojoId) {
    await adapters.showmojo.cancelShowing(showing.showmojoId, reason);
  }

  if (showing.googleEventId && showing.googleCalendarId) {
    const token = await getUsableAccessToken(tenantId);
    if (token.ok) {
      try {
        await adapters.calendar.deleteEvent({
          accessToken: token.accessToken,
          calendarId: showing.googleCalendarId,
          eventId: showing.googleEventId,
        });
      } catch (error) {
        // Mejor esfuerzo: la cancelación en la app no se bloquea porque
        // Google no responda, pero queda registrada.
        await writeAudit({
          tenantId,
          actorId: 'scheduling_service',
          actorType: 'system',
          action: 'showing.calendar_event_delete_failed',
          entityType: 'showing',
          entityId: showingId,
          payload: { error: error instanceof Error ? error.message : 'Unknown error' },
        });
      }
    }
  }

  await prisma.showing.update({
    where: { id: showingId },
    data: {
      status: 'cancelled',
      activeSlotKey: null,
      activeProspectSlotKey: null,
      calendarSlotKey: null,
    },
  });

  await writeAudit({
    tenantId,
    actorId: userId,
    actorType: 'user',
    action: 'showing.cancelled',
    entityType: 'showing',
    entityId: showingId,
    payload: { reason },
  });

  await createShowingConversationEvent({
    tenantId,
    showingId,
    leadId: showing.leadId,
    actorUserId: userId,
    type: 'showing.cancelled',
    scheduledAt: showing.scheduledAt,
    payload: { reason },
  });
}

export async function listShowings(
  tenantId: string,
  opts: { status?: string; leadId?: string } = {},
) {
  return prisma.showing.findMany({
    where: {
      tenantId,
      ...(opts.status ? { status: opts.status as never } : {}),
      ...(opts.leadId ? { leadId: opts.leadId } : {}),
    },
    orderBy: { scheduledAt: 'asc' },
    include: {
      lead: { select: { name: true, phone: true, email: true } },
      unit: {
        select: { name: true, property: { select: { name: true, address: true, city: true } } },
      },
    },
  });
}

async function createShowingConversationEvent(input: {
  tenantId: string;
  showingId: string;
  leadId: string;
  actorUserId: string;
  type: 'showing.confirmed' | 'showing.cancelled';
  scheduledAt: Date;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const conversation = await prisma.chatConversation.findFirst({
    where: { tenantId: input.tenantId, leadId: input.leadId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  if (!conversation) return;

  await createConversationEvent({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    leadId: input.leadId,
    actorUserId: input.actorUserId,
    type: input.type,
    payload: {
      showingId: input.showingId,
      scheduledAt: input.scheduledAt.toISOString(),
      ...(input.payload ?? {}),
    },
  });
}

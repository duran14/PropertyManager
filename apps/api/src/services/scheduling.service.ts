/**
 * Servicio de Scheduling — conecta el chatbot con ShowMojo.
 *
 * Cuando el FSM llega a 'scheduling':
 *  1. Obtiene horarios disponibles de ShowMojo para la unidad.
 *  2. El bot los propone al prospecto.
 *  3. El prospecto elige → se crea la visita en ShowMojo.
 *  4. Se crea un registro `Showing` en la BD.
 *  5. Se notifica al broker/PM asignado.
 *  6. El lead avanza a `tour_scheduled`.
 */
import type { ShowMojoAdapter, ShowMojoSlot } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';
import { getAdapters } from '../config/adapters.js';

export interface AvailableSlotsResult {
  slots: Array<{
    index: number;
    startAt: string;
    endAt: string;
    brokerName?: string;
    label: string; // texto legible para mostrar al prospecto
  }>;
}

/**
 * Obtiene horarios disponibles para una unidad y los formatea
 * para que el chatbot los presente al prospecto.
 */
export async function getAvailableSlots(
  tenantId: string,
  unitId: string,
  adapter: ShowMojoAdapter,
): Promise<AvailableSlotsResult> {
  const unit = await prisma.unit.findFirst({
    where: { id: unitId, tenantId },
    include: { property: true },
  });
  if (!unit) throw new Error('Unidad no encontrada');

  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + 14);

  const listingCode = `unit_${unit.slug}`;
  const slots = await adapter.getAvailableSlots(listingCode, from.toISOString(), to.toISOString());

  return {
    slots: slots.slice(0, 6).map((slot, index) => ({
      index,
      startAt: slot.startAt,
      endAt: slot.endAt,
      brokerName: slot.brokerName,
      label: formatSlotLabel(slot),
    })),
  };
}

/**
 * Agenda una visita: crea el showing en ShowMojo + en la BD.
 */
export async function scheduleTour(input: {
  tenantId: string;
  unitId: string;
  leadId: string;
  slotIndex: number;
  prospectName: string;
  prospectPhone?: string;
  prospectEmail?: string;
  conversationId?: string;
  adapter: ShowMojoAdapter;
}): Promise<{
  showingId: string;
  showmojoUrl: string;
  confirmUrl: string;
  scheduledAt: string;
}> {
  const { tenantId, unitId, leadId, slotIndex, adapter } = input;

  const unit = await prisma.unit.findFirst({
    where: { id: unitId, tenantId },
  });
  if (!unit) throw new Error('Unidad no encontrada');

  // Obtiene los slots de nuevo para seleccionar el elegido.
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + 14);
  const listingCode = `unit_${unit.slug}`;
  const slots = await adapter.getAvailableSlots(listingCode, from.toISOString(), to.toISOString());
  const slot = slots[slotIndex];
  if (!slot) throw new Error(`Slot ${slotIndex} no disponible`);

  // Crea la visita en ShowMojo.
  const { showing } = await adapter.createShowing({
    listingCode,
    slot,
    prospectName: input.prospectName,
    prospectPhone: input.prospectPhone,
    prospectEmail: input.prospectEmail,
  });

  // Persiste en la BD.
  const dbShowing = await prisma.showing.create({
    data: {
      tenantId,
      leadId,
      unitId,
      showmojoId: showing.id,
      scheduledAt: new Date(slot.startAt),
      status: 'scheduled',
      showmojoUrl: showing.showmojoUrl,
    },
  });

  // Actualiza el lead.
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'tour_scheduled',
      showmojoShowingId: showing.id,
      tourUrl: showing.showmojoUrl,
    },
  });

  await writeAudit({
    tenantId,
    actorId: 'chatbot_agent',
    actorType: 'ai_agent',
    action: 'showing.scheduled',
    entityType: 'showing',
    entityId: dbShowing.id,
    payload: {
      leadId,
      unitId,
      showmojoId: showing.id,
      scheduledAt: slot.startAt,
    },
  });

  // Notifica al broker/PM.
  await notifyBroker(tenantId, dbShowing.id, slot, input.prospectName);

  return {
    showingId: dbShowing.id,
    showmojoUrl: showing.showmojoUrl ?? '',
    confirmUrl: showing.confirmUrl ?? '',
    scheduledAt: slot.startAt,
  };
}

/**
 * Notifica al broker/PM que hay una visita nueva.
 * En MVP: log + auditoría. Con Twilio/email real: mandaría mensaje.
 */
async function notifyBroker(
  tenantId: string,
  showingId: string,
  slot: ShowMojoSlot,
  prospectName: string,
): Promise<void> {
  const message =
    `🗓️ Nueva visita agendada:\n` +
    `Prospecto: ${prospectName}\n` +
    `Fecha: ${formatSlotLabel(slot)}\n` +
    `Broker: ${slot.brokerName ?? 'Por asignar'}\n` +
    `Confirma la visita en el panel.`;

  console.log(`[Scheduling] Notificación al broker:\n${message}\n`);

  // En el futuro: buscar el broker asignado y mandarle WhatsApp/email.
  // Por ahora, solo auditoría.
  await writeAudit({
    tenantId,
    actorId: 'scheduling_service',
    actorType: 'system',
    action: 'showing.broker_notified',
    entityType: 'showing',
    entityId: showingId,
    payload: { message, brokerName: slot.brokerName },
  });
}

/** El broker confirma que está disponible para la visita. */
export async function confirmShowing(
  showingId: string,
  tenantId: string,
  brokerUserId: string,
): Promise<void> {
  const adapters = getAdapters();
  const showing = await prisma.showing.findFirst({
    where: { id: showingId, tenantId },
  });
  if (!showing) throw new Error('Visita no encontrada');

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
}

/** Cancela una visita. */
export async function cancelShowing(
  showingId: string,
  tenantId: string,
  userId: string,
  reason?: string,
): Promise<void> {
  const adapters = getAdapters();
  const showing = await prisma.showing.findFirst({
    where: { id: showingId, tenantId },
  });
  if (!showing) throw new Error('Visita no encontrada');

  if (showing.showmojoId) {
    await adapters.showmojo.cancelShowing(showing.showmojoId, reason);
  }

  await prisma.showing.update({
    where: { id: showingId },
    data: { status: 'cancelled' },
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
}

/** Lista las visitas de un tenant. */
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
      unit: { select: { name: true, property: { select: { name: true, address: true, city: true } } } },
    },
  });
}

function formatSlotLabel(slot: ShowMojoSlot): string {
  const start = new Date(slot.startAt);
  const dayName = start.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = start.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${dayName} a las ${time}${slot.brokerName ? ` (${slot.brokerName})` : ''}`;
}

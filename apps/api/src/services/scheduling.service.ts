/**
 * Scheduling service connecting the chatbot to ShowMojo.
 */
import type { ShowMojoAdapter, ShowMojoSlot } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';
import { createConversationEvent } from './conversation-events.service.js';

export interface AvailableSlotsResult {
  slots: Array<{
    index: number;
    startAt: string;
    endAt: string;
    brokerName?: string;
    label: string;
  }>;
}

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

export function resolveShowingBooking(
  existing: { unitId: string | null } | null,
  unitId: string,
): { kind: 'new' | 'existing' | 'conflict' } {
  if (!existing) return { kind: 'new' };
  return existing.unitId === unitId ? { kind: 'existing' } : { kind: 'conflict' };
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

export async function getAvailableSlots(
  tenantId: string,
  unitId: string,
  adapter: ShowMojoAdapter,
): Promise<AvailableSlotsResult> {
  const unit = await prisma.unit.findFirst({
    where: { id: unitId, tenantId },
    include: { property: true },
  });
  if (!unit) throw new Error('Unit not found');

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
  const showing = await prisma.$transaction(async (tx) => {
    const dbShowing = await tx.showing.create({
      data: {
        tenantId: input.tenantId,
        leadId,
        unitId,
        scheduledAt: input.scheduledAt,
        durationMinutes,
        status: 'scheduled',
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

  return showing;
}

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
  if (!unit) throw new Error('Unit not found');

  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + 14);
  const listingCode = `unit_${unit.slug}`;
  const slots = await adapter.getAvailableSlots(listingCode, from.toISOString(), to.toISOString());
  const slot = slots[slotIndex];
  if (!slot) throw new Error(`Slot ${slotIndex} is not available`);

  const scheduledAt = new Date(slot.startAt);
  const prospectSlotKey = buildProspectSlotKey({
    leadId,
    email: input.prospectEmail,
    phone: input.prospectPhone,
  }, scheduledAt);
  const existingShowing = await prisma.showing.findFirst({
    where: { tenantId, activeProspectSlotKey: prospectSlotKey },
    select: { id: true, unitId: true, showmojoUrl: true, scheduledAt: true },
  });
  const bookingResolution = resolveShowingBooking(existingShowing, unitId);
  if (bookingResolution.kind === 'existing' && existingShowing) {
    return {
      showingId: existingShowing.id,
      showmojoUrl: existingShowing.showmojoUrl ?? '',
      confirmUrl: '',
      scheduledAt: existingShowing.scheduledAt.toISOString(),
    };
  }
  if (bookingResolution.kind === 'conflict') {
    throw new Error('This prospect already has a showing scheduled at that time');
  }

  const { showing } = await adapter.createShowing({
    listingCode,
    slot,
    prospectName: input.prospectName,
    prospectPhone: input.prospectPhone,
    prospectEmail: input.prospectEmail,
  });

  const dbShowing = await prisma.showing.create({
    data: {
      tenantId,
      leadId,
      unitId,
      showmojoId: showing.id,
      scheduledAt,
      status: 'scheduled',
      showmojoUrl: showing.showmojoUrl,
      activeSlotKey: showingSlotKey(leadId, scheduledAt),
      activeProspectSlotKey: prospectSlotKey,
    },
  });

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      unitId,
      status: 'tour_scheduled',
      showmojoShowingId: showing.id,
      tourUrl: showing.showmojoUrl,
    },
  });

  if (input.conversationId) {
    await prisma.chatConversation.updateMany({
      where: { id: input.conversationId, tenantId },
      data: { unitId },
    });
  }

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

  await notifyBroker(tenantId, dbShowing.id, slot, input.prospectName);

  return {
    showingId: dbShowing.id,
    showmojoUrl: showing.showmojoUrl ?? '',
    confirmUrl: showing.confirmUrl ?? '',
    scheduledAt: slot.startAt,
  };
}

async function notifyBroker(
  tenantId: string,
  showingId: string,
  slot: ShowMojoSlot,
  prospectName: string,
): Promise<void> {
  const message =
    `New showing scheduled:\n` +
    `Prospect: ${prospectName}\n` +
    `Date: ${formatSlotLabel(slot)}\n` +
    `Broker: ${slot.brokerName ?? 'Unassigned'}\n` +
    `Confirm the showing in the dashboard.`;

  console.log(`[Scheduling] Broker notification:\n${message}\n`);

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

  await prisma.showing.update({
    where: { id: showingId },
    data: { status: 'cancelled', activeSlotKey: null, activeProspectSlotKey: null },
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

function formatSlotLabel(slot: ShowMojoSlot): string {
  const start = new Date(slot.startAt);
  const dayName = start.toLocaleDateString('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = start.toLocaleTimeString('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${dayName} at ${time}${slot.brokerName ? ` (${slot.brokerName})` : ''}`;
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { deliverDueShortlistReminders, sendDueShortlistReminders, type DueShortlistReminder } from './shortlist-reminders.js';

const dueReminder: DueShortlistReminder = {
  id: 'shortlist-1',
  reminderCount: 0,
  createdAt: new Date('2026-08-01T08:00:00.000Z'),
  conversation: { externalId: 'telegram:stale-chat', channel: 'telegram' },
};

describe('shortlist reminders', () => {
  it('quarantines an undeliverable reminder instead of crashing the bot worker', async () => {
    const markUndeliverable = vi.fn();

    const sent = await deliverDueShortlistReminders({
      findDue: async () => [dueReminder],
      send: vi.fn().mockRejectedValue(new Error('Telegram sendMessage failed: chat not found')),
      markSent: vi.fn(),
      markUndeliverable,
      now: new Date('2026-08-01T10:00:00.000Z'),
    });

    expect(sent).toBe(0);
    expect(markUndeliverable).toHaveBeenCalledWith(
      'shortlist-1',
      'Telegram sendMessage failed: chat not found',
    );
  });
});

// Fix 6: Lead.optedOutAt was only checked in remarketing.service.ts.
// sendDueShortlistReminders sends up to 3 proactive reminders per shortlist
// and never checked it, so a lead who explicitly opted out via
// detectOptOutPhrase could still get shortlist reminders if a new
// PropertyShortlist got created for them afterwards. This exercises the
// real Prisma query (not the injected-deps deliverDueShortlistReminders
// above) against the test database, since the fix lives in the query
// itself.
describe('sendDueShortlistReminders (opt-out gating)', () => {
  const TENANT_ID = 'tenant_test_shortlist_reminders';

  async function seedTenant() {
    await prisma.tenant.upsert({
      where: { id: TENANT_ID },
      update: {},
      create: { id: TENANT_ID, name: 'Shortlist Reminders Test Tenant', province: 'BC' },
    });
  }

  async function cleanup() {
    const conversations = await prisma.chatConversation.findMany({ where: { tenantId: TENANT_ID }, select: { id: true } });
    const conversationIds = conversations.map((c) => c.id);
    if (conversationIds.length > 0) {
      await prisma.propertyShortlist.deleteMany({ where: { conversationId: { in: conversationIds } } });
    }
    await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  }

  async function seedDueShortlist(options: { externalId: string; optedOutAt?: Date; withLead: boolean }) {
    const lead = options.withLead
      ? await prisma.lead.create({
          data: { tenantId: TENANT_ID, phone: options.externalId, source: 'web', status: 'new_', optedOutAt: options.optedOutAt },
        })
      : undefined;
    const conversation = await prisma.chatConversation.create({
      data: {
        tenantId: TENANT_ID,
        externalId: options.externalId,
        channel: 'web',
        state: 'proposing_units',
        leadId: lead?.id,
      },
    });
    const shortlist = await prisma.propertyShortlist.create({
      data: {
        tenantId: TENANT_ID,
        conversationId: conversation.id,
        tokenHash: `hash-${conversation.id}`,
        unitIds: ['unit-1'],
        status: 'awaiting_preference',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        nextReminderAt: new Date(Date.now() - 1000),
        remindersStopped: false,
      },
    });
    return { lead, conversation, shortlist };
  }

  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('excludes a due shortlist reminder whose lead has optedOutAt set', async () => {
    const { shortlist } = await seedDueShortlist({ externalId: 'reminder-opted-out', optedOutAt: new Date(), withLead: true });

    await sendDueShortlistReminders();

    const unchanged = await prisma.propertyShortlist.findUniqueOrThrow({ where: { id: shortlist.id } });
    expect(unchanged.reminderCount).toBe(0);
    expect(unchanged.lastReminderAt).toBeNull();
  });

  it('includes a due shortlist reminder for a lead that has not opted out', async () => {
    const { shortlist } = await seedDueShortlist({ externalId: 'reminder-active', withLead: true });

    await sendDueShortlistReminders();

    const updated = await prisma.propertyShortlist.findUniqueOrThrow({ where: { id: shortlist.id } });
    expect(updated.reminderCount).toBe(1);
  });

  it('includes a due shortlist reminder for a conversation with no linked lead yet (nullable relation must not be incorrectly excluded)', async () => {
    const { shortlist } = await seedDueShortlist({ externalId: 'reminder-no-lead', withLead: false });

    await sendDueShortlistReminders();

    const updated = await prisma.propertyShortlist.findUniqueOrThrow({ where: { id: shortlist.id } });
    expect(updated.reminderCount).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { deliverDueShortlistReminders, type DueShortlistReminder } from './shortlist-reminders.js';

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

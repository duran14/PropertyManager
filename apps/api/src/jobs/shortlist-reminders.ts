import type { ChatChannel } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';
import { getReplyAddressFromConversation } from '../services/chatbot.service.js';
import { nextReminderDate } from '../services/shortlist.service.js';

export type DueShortlistReminder = {
  id: string;
  reminderCount: number;
  createdAt: Date;
  conversation: { externalId: string; channel: ChatChannel };
};

export function startShortlistReminderWorker(): void {
  setInterval(() => {
    void sendDueShortlistReminders().catch((error) => {
      console.error('[Shortlist reminders] Worker error:', error);
    });
  }, 60_000).unref();
}

export async function deliverDueShortlistReminders(deps: {
  findDue: () => Promise<DueShortlistReminder[]>;
  send: (message: { to: string; body: string; channel: ChatChannel }) => Promise<unknown>;
  markSent: (item: DueShortlistReminder, now: Date) => Promise<void> | void;
  markUndeliverable: (id: string, error: string) => Promise<void> | void;
  now?: Date;
}): Promise<number> {
  const now = deps.now ?? new Date();
  let sent = 0;
  for (const item of await deps.findDue()) {
    try {
      await deps.send({
        to: getReplyAddressFromConversation(item.conversation.externalId),
        body: reminderBody(item.reminderCount),
        channel: item.conversation.channel,
      });
      await deps.markSent(item, now);
      sent += 1;
    } catch (error) {
      await deps.markUndeliverable(
        item.id,
        error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error',
      );
    }
  }
  return sent;
}

export async function sendDueShortlistReminders(now = new Date()): Promise<number> {
  const due = await prisma.propertyShortlist.findMany({
    where: { remindersStopped: false, scheduledAt: null, nextReminderAt: { lte: now }, expiresAt: { gt: now } },
    include: { conversation: true },
    take: 50,
  });
  const adapters = getAdapters();
  return deliverDueShortlistReminders({
    findDue: async () => due,
    send: (message) => adapters.messaging[message.channel].send(message),
    markSent: async (item, sentAt) => {
      const count = item.reminderCount + 1;
      await prisma.propertyShortlist.update({
        where: { id: item.id },
        data: {
          reminderCount: count,
          lastReminderAt: sentAt,
          nextReminderAt: nextReminderDate(item.createdAt, count),
          remindersStopped: count >= 3,
        },
      });
    },
    markUndeliverable: async (id, error) => {
      console.warn(`[Shortlist reminders] Stopped reminder ${id}: ${error}`);
      await prisma.propertyShortlist.update({
        where: { id },
        data: { remindersStopped: true, nextReminderAt: null },
      });
    },
    now,
  });
}

function reminderBody(reminderCount: number): string {
  return reminderCount === 0
    ? 'Hi — did any of the homes I shared stand out? I can help you compare them or find a tour time.'
    : reminderCount === 1
      ? 'Just checking in on your shortlist. Would you like me to show you the available tour times?'
      : 'One last check-in: would you like to tour one of these homes, or should I look for different options?';
}

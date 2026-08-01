import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';
import { getReplyAddressFromConversation } from '../services/chatbot.service.js';
import { nextReminderDate } from '../services/shortlist.service.js';

export function startShortlistReminderWorker(): void {
  setInterval(() => void sendDueShortlistReminders(), 60_000).unref();
}

export async function sendDueShortlistReminders(now = new Date()): Promise<number> {
  const due = await prisma.propertyShortlist.findMany({
    where: { remindersStopped: false, scheduledAt: null, nextReminderAt: { lte: now }, expiresAt: { gt: now } },
    include: { conversation: true },
    take: 50,
  });
  let sent = 0;
  for (const item of due) {
    const messaging = getAdapters().messaging[item.conversation.channel];
    const body = item.reminderCount === 0
      ? 'Hi — did any of the homes I shared stand out? I can help you compare them or find a tour time.'
      : item.reminderCount === 1
        ? 'Just checking in on your shortlist. Would you like me to show you the available tour times?'
        : 'One last check-in: would you like to tour one of these homes, or should I look for different options?';
    await messaging.send({ to: getReplyAddressFromConversation(item.conversation.externalId), body, channel: item.conversation.channel });
    const count = item.reminderCount + 1;
    await prisma.propertyShortlist.update({
      where: { id: item.id },
      data: { reminderCount: count, lastReminderAt: now, nextReminderAt: nextReminderDate(item.createdAt, count), remindersStopped: count >= 3 },
    });
    sent++;
  }
  return sent;
}

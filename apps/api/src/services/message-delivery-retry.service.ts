import type { ChatChannel } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';

const MAX_DELIVERY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export interface FailedDeliveryMessage {
  id: string;
  content: string;
  deliveryAttempts: number;
  providerMessageIds: string[];
  conversation: { externalId: string; channel: ChatChannel };
}

export function nextDeliveryRetryAt(attempt: number, now = new Date()): Date {
  const delay = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay);
}

export async function retryFailedMessageDeliveries(deps: {
  findFailed: () => Promise<FailedDeliveryMessage[]>;
  send: (message: { to: string; body: string; channel: ChatChannel }) => Promise<{ messageId: string }>;
  markSent: (id: string, providerMessageIds: string[]) => Promise<void> | void;
  markFailed: (id: string, attempts: number, nextAttemptAt: Date, error: string) => Promise<void> | void;
  now?: Date;
}): Promise<number> {
  const now = deps.now ?? new Date();
  let retried = 0;
  for (const message of await deps.findFailed()) {
    const nextAttempt = message.deliveryAttempts + 1;
    try {
      const result = await deps.send({
        to: replyAddress(message.conversation.externalId),
        body: message.content,
        channel: message.conversation.channel,
      });
      await deps.markSent(message.id, [...message.providerMessageIds, result.messageId]);
      retried += 1;
    } catch (error) {
      await deps.markFailed(
        message.id,
        nextAttempt,
        nextDeliveryRetryAt(nextAttempt, now),
        error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error',
      );
    }
  }
  return retried;
}

export function startMessageDeliveryRetryWorker(): void {
  setInterval(() => void retryDueMessageDeliveries(), 60_000).unref();
}

export async function retryDueMessageDeliveries(now = new Date()): Promise<number> {
  const failed = await prisma.chatMessage.findMany({
    where: {
      role: 'assistant',
      deliveryStatus: 'failed',
      deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS },
      deliveryNextAttemptAt: { lte: now },
    },
    include: { conversation: true },
    take: 50,
  });
  const adapters = getAdapters();
  return retryFailedMessageDeliveries({
    findFailed: async () => failed,
    send: (message) => adapters.messaging[message.channel].send(message),
    markSent: async (id, providerMessageIds) => {
      await prisma.chatMessage.update({
        where: { id },
        data: {
          deliveryStatus: 'sent',
          deliveryError: null,
          deliveryNextAttemptAt: null,
          deliveryAttempts: { increment: 1 },
          providerMessageIds,
        },
      });
    },
    markFailed: async (id, attempts, nextAttemptAt, error) => {
      await prisma.chatMessage.update({
        where: { id },
        data: { deliveryAttempts: attempts, deliveryNextAttemptAt: nextAttemptAt, deliveryError: error },
      });
    },
    now,
  });
}

function replyAddress(externalId: string): string {
  return externalId.replace(/^(sms|whatsapp|telegram):/, '');
}

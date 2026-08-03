import { describe, expect, it, vi } from 'vitest';
import {
  retryFailedMessageDeliveries,
  nextDeliveryRetryAt,
  type FailedDeliveryMessage,
} from './message-delivery-retry.service.js';

const now = new Date('2026-08-01T08:30:00.000Z');

function failedMessage(overrides: Partial<FailedDeliveryMessage> = {}): FailedDeliveryMessage {
  return {
    id: 'message-1',
    content: 'Open your shortlist: http://localhost:5173/shortlist/a_b',
    deliveryAttempts: 1,
    providerMessageIds: [],
    conversation: { externalId: 'telegram:12345', channel: 'telegram' },
    ...overrides,
  };
}

describe('message delivery retry', () => {
  it('redelivers a failed message and records the provider receipt', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'tg_99' });
    const markSent = vi.fn();

    const retried = await retryFailedMessageDeliveries({
      findFailed: async () => [failedMessage()],
      send,
      markSent,
      markFailed: vi.fn(),
      now,
    });

    expect(retried).toBe(1);
    expect(send).toHaveBeenCalledWith({
      to: '12345',
      channel: 'telegram',
      body: 'Open your shortlist: http://localhost:5173/shortlist/a_b',
    });
    expect(markSent).toHaveBeenCalledWith('message-1', ['tg_99']);
  });

  it('keeps a failed message eligible for a later retry with exponential backoff', async () => {
    const markFailed = vi.fn();
    await retryFailedMessageDeliveries({
      findFailed: async () => [failedMessage({ deliveryAttempts: 2 })],
      send: vi.fn().mockRejectedValue(new Error('Telegram unavailable')),
      markSent: vi.fn(),
      markFailed,
      now,
    });

    expect(markFailed).toHaveBeenCalledWith(
      'message-1',
      3,
      new Date('2026-08-01T08:50:00.000Z'),
      'Telegram unavailable',
    );
  });

  it('doubles the retry delay while capping it at one hour', () => {
    expect(nextDeliveryRetryAt(1, now)).toEqual(new Date('2026-08-01T08:35:00.000Z'));
    expect(nextDeliveryRetryAt(5, now)).toEqual(new Date('2026-08-01T09:30:00.000Z'));
  });
});

import { describe, expect, it } from 'vitest';
import { MessengerMockAdapter } from './messenger.mock.js';

describe('MessengerMockAdapter', () => {
  it('records sent messages instead of calling a real API', async () => {
    const adapter = new MessengerMockAdapter();
    const result = await adapter.send({ to: 'psid-1', body: 'Hola', channel: 'messenger' });

    expect(result.messageId).toMatch(/^messenger_msg_/);
    expect(adapter.sent).toEqual([{ to: 'psid-1', body: 'Hola', channel: 'messenger' }]);
  });

  it('parses a webhook payload the same way the real adapter does', async () => {
    const adapter = new MessengerMockAdapter();
    const inbound = await adapter.parseWebhook({}, {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'Hola' } }] }],
    });

    expect(inbound).toMatchObject({ from: 'psid-1', body: 'Hola', channel: 'messenger', messageId: 'mid-1' });
  });

  it('throws on a payload with nothing actionable', async () => {
    const adapter = new MessengerMockAdapter();
    await expect(adapter.parseWebhook({}, { entry: [] })).rejects.toThrow();
  });
});

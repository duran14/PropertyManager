import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessengerRealAdapter } from './messenger.real.js';

describe('MessengerRealAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a text message to the Graph API with the page access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: 'mid-sent-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MessengerRealAdapter('page-token-123');
    const result = await adapter.send({ to: 'psid-1', body: 'Hola', channel: 'messenger' });

    expect(result).toEqual({ messageId: 'mid-sent-1' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('graph.facebook.com');
    expect(String(url)).toContain('page-token-123');
    expect(JSON.parse(options.body)).toEqual({
      recipient: { id: 'psid-1' },
      message: { text: 'Hola' },
    });
  });

  it('throws with the Graph API error body when the send fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => '{"error":"invalid token"}',
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MessengerRealAdapter('bad-token');
    await expect(adapter.send({ to: 'psid-1', body: 'Hola', channel: 'messenger' }))
      .rejects.toThrow('invalid token');
  });

  it('parses a webhook payload into an InboundMessage', async () => {
    const adapter = new MessengerRealAdapter('page-token-123');
    const inbound = await adapter.parseWebhook({}, {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'Hola' } }] }],
    });

    expect(inbound).toMatchObject({ from: 'psid-1', body: 'Hola', channel: 'messenger', messageId: 'mid-1' });
  });

  it('throws when the payload has nothing actionable (echo, attachment, postback)', async () => {
    const adapter = new MessengerRealAdapter('page-token-123');
    await expect(adapter.parseWebhook({}, { entry: [] })).rejects.toThrow();
  });
});

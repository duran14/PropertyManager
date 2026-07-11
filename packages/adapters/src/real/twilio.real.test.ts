import { describe, expect, it, vi } from 'vitest';
import { TwilioRealAdapter } from './twilio.real.js';

describe('TwilioRealAdapter', () => {
  it('sends SMS messages through Twilio Messages API', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 }));
    const adapter = new TwilioRealAdapter({
      accountSid: 'AC123',
      authToken: 'secret',
      fetchImpl: fetchMock,
    });

    const result = await adapter.send({
      to: '+16045551234',
      from: '+16045550000',
      body: 'Hello from Property Manager',
      channel: 'sms',
    });

    expect(result).toEqual({ messageId: 'SM123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('AC123:secret').toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toBe('To=%2B16045551234&From=%2B16045550000&Body=Hello+from+Property+Manager');
  });

  it('adds WhatsApp channel prefixes before sending WhatsApp messages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'SM456' }), { status: 201 }));
    const adapter = new TwilioRealAdapter({
      accountSid: 'AC123',
      authToken: 'secret',
      fetchImpl: fetchMock,
    });

    await adapter.send({
      to: '+16045551234',
      from: '+16045550000',
      body: 'Hello on WhatsApp',
      channel: 'whatsapp',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toBe(
      'To=whatsapp%3A%2B16045551234&From=whatsapp%3A%2B16045550000&Body=Hello+on+WhatsApp',
    );
  });

  it('throws a useful error when Twilio rejects a message', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ message: 'The From phone number is not valid.' }),
      { status: 400 },
    ));
    const adapter = new TwilioRealAdapter({
      accountSid: 'AC123',
      authToken: 'secret',
      fetchImpl: fetchMock,
    });

    await expect(adapter.send({
      to: '+16045551234',
      from: '+16045550000',
      body: 'Hello',
      channel: 'sms',
    })).rejects.toThrow('Twilio send failed: The From phone number is not valid.');
  });

  it('parses inbound Twilio webhook payloads into normalized messages', async () => {
    const adapter = new TwilioRealAdapter({ accountSid: 'AC123', authToken: 'secret' });

    const inbound = await adapter.parseWebhook({}, {
      From: 'whatsapp:+16045551234',
      To: 'whatsapp:+16045550000',
      Body: 'Can I tour this property?',
      MessageSid: 'SM789',
    });

    expect(inbound).toMatchObject({
      from: '+16045551234',
      to: '+16045550000',
      body: 'Can I tour this property?',
      channel: 'whatsapp',
      messageId: 'SM789',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { TwilioMockAdapter } from './twilio.mock.js';

describe('TwilioMockAdapter', () => {
  it('parses SMS webhook payloads as sms messages', async () => {
    const adapter = new TwilioMockAdapter();

    const inbound = await adapter.parseWebhook({}, {
      From: '+16045551234',
      To: '+16045550000',
      Body: 'Is this unit still available?',
      MessageSid: 'SM123',
    });

    expect(inbound).toMatchObject({
      from: '+16045551234',
      to: '+16045550000',
      body: 'Is this unit still available?',
      channel: 'sms',
      messageId: 'SM123',
    });
  });

  it('parses WhatsApp webhook payloads as whatsapp messages without provider prefixes', async () => {
    const adapter = new TwilioMockAdapter();

    const inbound = await adapter.parseWebhook({}, {
      From: 'whatsapp:+16045551234',
      To: 'whatsapp:+16045550000',
      Body: 'Can I schedule a showing?',
      MessageSid: 'SM456',
    });

    expect(inbound).toMatchObject({
      from: '+16045551234',
      to: '+16045550000',
      body: 'Can I schedule a showing?',
      channel: 'whatsapp',
      messageId: 'SM456',
    });
  });
});

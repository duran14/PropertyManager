import type { TwilioAdapter, TwilioInbound, TwilioMessage } from '../contracts.js';

/**
 * Twilio mock: keeps sent messages in memory and parses Twilio-style inbound payloads.
 */
export class TwilioMockAdapter implements TwilioAdapter {
  readonly name = 'twilio' as const;

  sent: TwilioMessage[] = [];

  async send(message: TwilioMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `SM${Date.now()}` };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<TwilioInbound> {
    const payload = body as { From?: string; To?: string; Body?: string; MessageSid?: string };
    const from = payload.From ?? '+16045551234';
    const to = payload.To ?? '+16045550000';
    const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms';

    return {
      from: stripTwilioChannelPrefix(from),
      to: stripTwilioChannelPrefix(to),
      body: payload.Body ?? 'Hi, are there any units available?',
      channel,
      receivedAt: new Date().toISOString(),
      messageId: payload.MessageSid ?? `SM${Date.now()}`,
    };
  }
}

function stripTwilioChannelPrefix(value: string): string {
  return value.replace(/^whatsapp:/, '');
}

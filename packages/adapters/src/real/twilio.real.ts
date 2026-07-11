import type { TwilioAdapter, TwilioInbound, TwilioMessage } from '../contracts.js';

export interface TwilioRealAdapterOptions {
  accountSid: string;
  authToken: string;
  fetchImpl?: typeof fetch;
}

export class TwilioRealAdapter implements TwilioAdapter {
  readonly name = 'twilio' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TwilioRealAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: TwilioMessage): Promise<{ messageId: string }> {
    const body = new URLSearchParams({
      To: formatTwilioAddress(message.to, message.channel),
      From: formatTwilioAddress(message.from, message.channel),
      Body: message.body,
    });

    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${this.options.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );

    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) {
      throw new Error(`Twilio send failed: ${data.message ?? res.statusText}`);
    }

    if (!data.sid) {
      throw new Error('Twilio send failed: missing message sid');
    }

    return { messageId: data.sid };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<TwilioInbound> {
    const payload = body as { From?: string; To?: string; Body?: string; MessageSid?: string };
    const from = payload.From ?? '';
    const to = payload.To ?? '';
    const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms';

    return {
      from: stripTwilioChannelPrefix(from),
      to: stripTwilioChannelPrefix(to),
      body: payload.Body ?? '',
      channel,
      receivedAt: new Date().toISOString(),
      messageId: payload.MessageSid ?? '',
    };
  }
}

function formatTwilioAddress(value: string, channel: 'sms' | 'whatsapp'): string {
  if (channel !== 'whatsapp' || value.startsWith('whatsapp:')) {
    return value;
  }
  return `whatsapp:${value}`;
}

function stripTwilioChannelPrefix(value: string): string {
  return value.replace(/^whatsapp:/, '');
}

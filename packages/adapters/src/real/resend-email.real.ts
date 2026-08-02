import type { ChatChannel, InboundMessage, MessagingAdapter, OutboundMessage } from '../contracts.js';

export interface ResendEmailAdapterOptions {
  apiKey: string;
  from: string;
  fetcher?: typeof fetch;
}

export class ResendEmailAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'email';
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ResendEmailAdapterOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    if (message.channel !== 'email') {
      throw new Error('ResendEmailAdapter only supports email messages');
    }

    const response = await this.fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [message.to],
        subject: message.subject ?? 'Property tour update',
        text: message.body,
      }),
    });
    const payload = await response.json().catch(() => null) as { id?: string; message?: string } | null;
    if (!response.ok || !payload?.id) {
      throw new Error(payload?.message ?? `Resend failed with status ${response.status}`);
    }
    return { messageId: payload.id };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    _body: unknown,
  ): Promise<InboundMessage> {
    throw new Error('ResendEmailAdapter does not support inbound webhooks.');
  }
}

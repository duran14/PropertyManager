import type { ChatChannel, InboundMessage, MessagingAdapter, OutboundMessage } from '../contracts.js';

export class EmailMockAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'email';
  sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `email_msg_${Date.now()}` };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    _body: unknown,
  ): Promise<InboundMessage> {
    throw new Error('EmailMockAdapter does not support inbound webhooks.');
  }
}

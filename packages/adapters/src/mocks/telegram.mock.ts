/**
 * Mock de Telegram Bot API.
 *
 * Simula el envío y recepción de mensajes vía Telegram.
 * En producción, usaría la API de Telegram Bot (getUpdates / sendMessage).
 */
import type {
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
  ChatChannel,
} from '../contracts.js';

export class TelegramMockAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'telegram';

  sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `tg_msg_${Date.now()}` };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<InboundMessage> {
    const update = body as {
      message?: {
        message_id: number;
        chat: { id: number };
        text?: string;
        photo?: Array<{ file_id: string }>;
      };
    };
    const msg = update.message;
    return {
      from: String(msg?.chat?.id ?? '0'),
      body: msg?.text ?? '',
      channel: 'telegram',
      receivedAt: new Date().toISOString(),
      messageId: String(msg?.message_id ?? Date.now()),
      mediaUrls: msg?.photo?.map((p) => p.file_id),
    };
  }
}

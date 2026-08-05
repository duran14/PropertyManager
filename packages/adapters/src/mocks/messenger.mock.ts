/**
 * Mock de la Graph API de Messenger.
 * Simula el envío y recepción de mensajes sin llamar a Meta.
 */
import type {
  ChatChannel,
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
} from '../contracts.js';
import { extractMessengerTextMessage } from '../real/messenger-payload.js';

export class MessengerMockAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'messenger';

  sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `messenger_msg_${Date.now()}` };
  }

  async parseWebhook(_headers: Record<string, string>, body: unknown): Promise<InboundMessage> {
    const extracted = extractMessengerTextMessage(body);
    if (!extracted) {
      throw new Error('Messenger webhook payload sin mensaje de texto procesable (eco, adjunto, o postback)');
    }
    return {
      from: extracted.senderId,
      body: extracted.text,
      channel: 'messenger',
      receivedAt: new Date().toISOString(),
      messageId: extracted.mid,
    };
  }
}

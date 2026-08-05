/**
 * Mock de Facebook Messenger (Send/Receive API).
 *
 * Placeholder mínimo para que `ChatChannel`/`IntegrationKey` incluyan
 * 'messenger' de forma exhaustiva en el factory sin romper el build.
 * La lógica real de envío/parseo de webhooks de Messenger se implementa
 * en un task posterior (adapter real + wiring del factory + rutas de webhook).
 */
import type {
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
  ChatChannel,
} from '../contracts.js';

export class MessengerMockAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'messenger';

  sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `messenger_msg_${Date.now()}` };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    _body: unknown,
  ): Promise<InboundMessage> {
    throw new Error('Messenger webhook parsing no está implementado todavía.');
  }
}

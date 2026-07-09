/**
 * Mock de WebChat — chat embebido en la página pública de la unidad.
 *
 * A diferencia de Twilio/Telegram, el web chat no usa webhooks entrantes:
 * los mensajes llegan vía POST /chat/messages (API directa).
 * Este adapter solo maneja el envío de respuestas del bot (que en web chat
 * se devuelve directamente en la respuesta HTTP, no se envía a un servicio).
 */
import type {
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
  ChatChannel,
} from '../contracts.js';

export class WebChatMockAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'web';

  sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    // En web chat, el mensaje se devuelve directamente al cliente via HTTP.
    // Aquí lo guardamos para logs/auditoría.
    this.sent.push(message);
    return { messageId: `web_msg_${Date.now()}` };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    _body: unknown,
  ): Promise<InboundMessage> {
    // Web chat no usa webhooks — los mensajes llegan por API directa.
    throw new Error('WebChat no soporta webhooks. Usa POST /chat/messages.');
  }
}

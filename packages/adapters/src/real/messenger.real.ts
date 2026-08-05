/**
 * Adapter REAL de Facebook Messenger — usa la Graph API de Meta vía webhook
 * (a diferencia de Telegram, Messenger no soporta long-polling).
 */
import type {
  ChatChannel,
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
} from '../contracts.js';
import { extractMessengerTextMessage } from './messenger-payload.js';

const GRAPH_API_VERSION = 'v21.0';

export class MessengerRealAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'messenger';

  constructor(private readonly pageAccessToken: string) {}

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(this.pageAccessToken)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: message.to },
        message: { text: message.body },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Messenger send falló: ${err}`);
    }
    const data = (await res.json()) as { message_id: string };
    return { messageId: data.message_id };
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

import type { InboundMessage } from '../contracts.js';

export interface MessengerTextMessage {
  senderId: string;
  mid: string;
  text: string;
}

interface MessengerWebhookBody {
  entry?: Array<{
    messaging?: Array<{
      sender?: { id?: string };
      message?: { mid?: string; text?: string; is_echo?: boolean };
    }>;
  }>;
}

/**
 * Extrae el primer mensaje de texto entrante y no-eco de un payload de
 * webhook de Messenger. Devuelve null para eco, adjuntos, postbacks, o
 * payloads sin nada procesable — esos casos se ignoran (200 OK) en vez de
 * tratarse como error, tanto en el adapter (Task 5/6) como en la ruta del
 * webhook (Task 8).
 */
export function extractMessengerTextMessage(body: unknown): MessengerTextMessage | null {
  if (!body || typeof body !== 'object') return null;
  const payload = body as MessengerWebhookBody;

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const message = event.message;
      if (!message || message.is_echo) continue;
      if (typeof message.text !== 'string' || message.text.length === 0) continue;
      if (typeof message.mid !== 'string' || message.mid.length === 0) continue;
      const senderId = event.sender?.id;
      if (typeof senderId !== 'string' || senderId.length === 0) continue;
      return { senderId, mid: message.mid, text: message.text };
    }
  }
  return null;
}

/**
 * Construye el InboundMessage canónico a partir de un mensaje de texto de
 * Messenger ya extraído. Único punto de verdad para esta forma — evita que
 * el adapter real, el mock, y la ruta del webhook (que no puede llamar a
 * parseWebhook porque necesita el `mid` antes de poder reclamar) diverjan.
 */
export function toMessengerInboundMessage(extracted: MessengerTextMessage): InboundMessage {
  return {
    from: extracted.senderId,
    body: extracted.text,
    channel: 'messenger',
    receivedAt: new Date().toISOString(),
    messageId: extracted.mid,
  };
}

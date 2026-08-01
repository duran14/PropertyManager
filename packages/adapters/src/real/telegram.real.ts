/**
 * Adapter REAL de Telegram — usa la Bot API con long polling.
 *
 * En desarrollo local no tenemos URL pública para webhooks, así que usamos
 * getUpdates (long polling). En producción con URL pública, se cambiaría a
 * setWebhook para recibir push en vez de poll.
 */
import type {
  ChatChannel,
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
} from '../contracts.js';

export class TelegramRealAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'telegram';
  private readonly baseUrl: string;
  private offset = 0;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.to,
        text: message.body,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram sendMessage falló: ${err}`);
    }
    const data = (await res.json()) as { result: { message_id: number } };
    return { messageId: `tg_${data.result.message_id}` };
  }

  /**
   * Muestra el indicador "escribiendo…" en el chat. Telegram lo expira a los ~5s,
   * así que el caller debe refrescarlo si el delay es largo. Falla silenciosamente:
   * un typing que no se envía nunca debe romper el flujo del bot.
   */
  async sendTyping(chatId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      });
    } catch {
      // No-op: el typing es cosmético; si falla, el mensaje se envía igual.
    }
  }

  async sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<void> {
    if (photoUrl.startsWith('/')) {
      const webUrl = process.env.WEB_URL ?? 'http://localhost:5173';
      const localAssetUrl = new URL(photoUrl, webUrl).toString();
      const asset = await fetch(localAssetUrl);
      if (!asset.ok) {
        throw new Error(`Could not load local listing photo: ${localAssetUrl}`);
      }

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo', await asset.blob(), photoUrl.split('/').at(-1) ?? 'listing-photo.png');
      if (caption) form.append('caption', caption);

      const res = await fetch(`${this.baseUrl}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Telegram sendPhoto failed: ${err}`);
      }
      return;
    }

    const res = await fetch(`${this.baseUrl}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram sendPhoto failed: ${err}`);
    }
  }

  /**
   * Long polling: pregunta a Telegram por updates nuevos.
   * Bloquea hasta 30s esperando mensajes (long polling nativo de Telegram).
   * Devuelve un array de mensajes entrantes.
   */
  async pollUpdates(): Promise<InboundMessage[]> {
    const url = `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=25`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        ok: boolean;
        result: Array<{
          update_id: number;
          message?: {
            message_id: number;
            chat: { id: number };
            text?: string;
            photo?: Array<{ file_id: string }>;
            from?: { first_name?: string };
          };
        }>;
      };
      if (!data.ok || !data.result) return [];

      const messages: InboundMessage[] = [];
      for (const update of data.result) {
        this.offset = update.update_id + 1;
        if (update.message?.text) {
          messages.push({
            from: String(update.message.chat.id),
            body: update.message.text,
            channel: 'telegram',
            receivedAt: new Date().toISOString(),
            messageId: String(update.message.message_id),
            mediaUrls: update.message.photo?.map((p) => p.file_id),
          });
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * No usamos webhook en este adapter (usamos polling).
   * El método existe para cumplir con la interfaz MessagingAdapter.
   */
  async parseWebhook(
    _headers: Record<string, string>,
    _body: unknown,
  ): Promise<InboundMessage> {
    throw new Error('TelegramRealAdapter usa polling, no webhooks. Usa pollUpdates().');
  }

  /** Verifica que el token es válido consultando getMe. */
  async verifyToken(): Promise<{ ok: boolean; botName?: string }> {
    const res = await fetch(`${this.baseUrl}/getMe`);
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as {
      ok: boolean;
      result?: { username: string; first_name: string };
    };
    return { ok: data.ok, botName: data.result?.first_name };
  }
}

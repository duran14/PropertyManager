import type { TwilioAdapter, TwilioInbound, TwilioMessage } from '../contracts.js';

/**
 * Mock de Twilio: captura los mensajes "enviados" en memoria para que los tests
 * puedan verificar que el sistema despachó la notificación correcta.
 */
export class TwilioMockAdapter implements TwilioAdapter {
  readonly name = 'twilio' as const;

  sent: TwilioMessage[] = [];

  async send(message: TwilioMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `SM${Date.now()}` };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<TwilioInbound> {
    const payload = body as { From?: string; To?: string; Body?: string; MessageSid?: string };
    return {
      from: payload.From ?? '+16045551234',
      to: payload.To ?? '+16045550000',
      body: payload.Body ?? 'Hola, ¿tienen disponibles?',
      channel: 'whatsapp',
      receivedAt: new Date().toISOString(),
      messageId: payload.MessageSid ?? `SM${Date.now()}`,
    };
  }
}

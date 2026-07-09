/**
 * Mock de Autoenhance.ai.
 *
 * Simula el flujo asíncrono: requestEnhancement devuelve un orderId,
 * y getEnhancementStatus simula que el procesamiento tarda.
 * En los tests, se puede llamar a completeOrder() para simular el webhook.
 */
import type {
  EnhancementRequest,
  EnhancementResult,
  PhotoEnhancementAdapter,
} from '../contracts.js';

interface MockOrder {
  orderId: string;
  request: EnhancementRequest;
  status: 'processing' | 'completed' | 'failed';
  enhancedUrl?: string;
}

export class PhotoEnhancementMockAdapter implements PhotoEnhancementAdapter {
  readonly name = 'photo_enhancement' as const;

  private orders = new Map<string, MockOrder>();
  private counter = 0;

  async requestEnhancement(request: EnhancementRequest): Promise<{ orderId: string }> {
    const orderId = `ae_order_${++this.counter}`;
    this.orders.set(orderId, {
      orderId,
      request,
      status: 'processing',
    });
    return { orderId };
  }

  async getEnhancementStatus(orderId: string): Promise<EnhancementResult> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Orden no encontrada: ${orderId}`);
    }
    return {
      orderId: order.orderId,
      status: order.status,
      enhancedUrl: order.enhancedUrl,
    };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<{ orderId: string; status: 'completed' | 'failed'; enhancedUrl?: string }> {
    const payload = body as { order_id?: string; status?: string; enhanced_url?: string };
    return {
      orderId: payload.order_id ?? 'unknown',
      status: payload.status === 'failed' ? 'failed' : 'completed',
      enhancedUrl: payload.enhanced_url,
    };
  }

  /** Helper de test: simula que una orden terminó de procesarse. */
  completeOrder(orderId: string, enhancedUrl?: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = 'completed';
      order.enhancedUrl =
        enhancedUrl ??
        `https://mock-cdn.autoenhance.ai/enhanced/${orderId}.jpg`;
    }
  }
}

import type { StripeAdapter } from '../contracts.js';

/**
 * Mock de Stripe Connect.
 *
 * IMPORTANTE (Regla de Oro): en el MVP Stripe NO se usa activamente.
 * Existe el contract para que la arquitectura soporte ejecución de pagos
 * en el futuro, pero el sistema NUNCA es custodio de fondos hoy.
 */
export class StripeMockAdapter implements StripeAdapter {
  readonly name = 'stripe' as const;

  async createPaymentIntent(input: {
    amountCents: number;
    currency: string;
    description: string;
  }): Promise<{ id: string; clientSecret: string }> {
    return {
      id: `pi_mock_${Date.now()}`,
      clientSecret: `${input.currency}_${input.amountCents}_mock_secret`,
    };
  }
}

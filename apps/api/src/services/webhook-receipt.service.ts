import { randomUUID } from 'node:crypto';
import { prisma } from '../config/db.js';
import { withTenant } from '../config/tenant-context.js';

export type WebhookMessageClaim =
  | { state: 'acquired'; claimToken: string }
  | { state: 'processing' }
  | { state: 'completed' }
  | { state: 'failed' };

/**
 * Reclama un mensaje entrante de un webhook de proveedor (Twilio, Messenger,
 * ...) por su ID único de proveedor, para deduplicar reintentos. Genérico
 * sobre `provider`: WebhookReceipt no tiene nada específico de un canal en
 * particular, solo agrupa por (tenantId, provider, providerMessageId).
 */
export async function claimWebhookMessage(
  provider: string,
  tenantId: string,
  providerMessageId: string,
): Promise<WebhookMessageClaim> {
  return withTenant(prisma, tenantId, async (tx) => {
    const claimToken = randomUUID();
    const result = await tx.webhookReceipt.createMany({
      data: [{ tenantId, provider, providerMessageId, claimToken }],
      skipDuplicates: true,
    });
    if (result.count === 1) {
      return { state: 'acquired', claimToken };
    }

    const receipt = await tx.webhookReceipt.findUniqueOrThrow({
      where: {
        tenantId_provider_providerMessageId: {
          tenantId,
          provider,
          providerMessageId,
        },
      },
    });
    if (receipt.status === 'completed') return { state: 'completed' };
    if (receipt.status === 'failed') return { state: 'failed' };
    return { state: 'processing' };
  });
}

export async function failWebhookMessage(
  provider: string,
  tenantId: string,
  providerMessageId: string,
  claimToken: string,
): Promise<void> {
  await withTenant(prisma, tenantId, (tx) => tx.webhookReceipt.updateMany({
    where: { tenantId, provider, providerMessageId, status: 'processing', claimToken },
    data: { status: 'failed' },
  }));
}

export async function completeWebhookMessage(
  provider: string,
  tenantId: string,
  providerMessageId: string,
  claimToken: string,
): Promise<void> {
  await withTenant(prisma, tenantId, (tx) => tx.webhookReceipt.updateMany({
    where: { tenantId, provider, providerMessageId, status: 'processing', claimToken },
    data: { status: 'completed' },
  }));
}

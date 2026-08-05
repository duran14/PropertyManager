import { describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import {
  claimWebhookMessage,
  completeWebhookMessage,
  failWebhookMessage,
} from './webhook-receipt.service.js';

describe('webhook receipt claim/complete/fail', () => {
  it('distinguishes processing, completed, and failed provider messages', async () => {
    const tenantId = 'tenant_test_webhook_receipt';
    const provider = 'test_provider';
    const messageId = 'MSG-security-test';
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'Webhook Receipt Test', province: 'BC' },
    });
    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });

    const firstClaim = await claimWebhookMessage(provider, tenantId, messageId);
    expect(firstClaim.state).toBe('acquired');
    if (firstClaim.state !== 'acquired') throw new Error('Expected first claim to be acquired');
    expect(firstClaim.claimToken).toBeTruthy();
    await expect(claimWebhookMessage(provider, tenantId, messageId)).resolves.toEqual({ state: 'processing' });

    await completeWebhookMessage(provider, tenantId, messageId, firstClaim.claimToken);
    await expect(claimWebhookMessage(provider, tenantId, messageId)).resolves.toEqual({ state: 'completed' });

    const failedId = `${messageId}-failed`;
    const failedClaim = await claimWebhookMessage(provider, tenantId, failedId);
    expect(failedClaim.state).toBe('acquired');
    if (failedClaim.state !== 'acquired') throw new Error('Expected failed claim to be acquired first');
    await failWebhookMessage(provider, tenantId, failedId, failedClaim.claimToken);
    await expect(claimWebhookMessage(provider, tenantId, failedId)).resolves.toEqual({ state: 'failed' });

    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it('keeps claims isolated per provider for the same tenant and message id', async () => {
    const tenantId = 'tenant_test_webhook_receipt_multi_provider';
    const messageId = 'MSG-shared-id';
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'Webhook Receipt Multi-Provider Test', province: 'BC' },
    });
    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });

    const twilioClaim = await claimWebhookMessage('twilio', tenantId, messageId);
    const messengerClaim = await claimWebhookMessage('messenger', tenantId, messageId);
    expect(twilioClaim.state).toBe('acquired');
    expect(messengerClaim.state).toBe('acquired');

    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });
});

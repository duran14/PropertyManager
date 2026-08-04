import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import {
  claimAndPrepareTwilioMessage,
  processClaimedTwilioMessage,
  type TwilioClaimResult,
} from './webhooks.js';

/**
 * Prueba que la separación "ACK rápido / procesamiento lento" del webhook
 * de Twilio funciona como se espera: `claimAndPrepareTwilioMessage` hace
 * solo el trabajo rápido que debe terminar antes de responderle a Twilio
 * (firma, deduplicación, parseo), y `processClaimedTwilioMessage` — la
 * parte lenta que antes bloqueaba la respuesta del webhook — sigue
 * completando el trabajo real (correr el bot, marcar el recibo) cuando se
 * ejecuta por separado, sin conexión HTTP de por medio.
 *
 * No revalida la máquina de estados de claim/complete/fail en sí (ya
 * cubierta en twilio-webhook-security.service.test.ts); esto prueba que
 * las rutas realmente usan esas primitivas en el orden correcto.
 */

const TENANT_ID = 'tenant_test_twilio_webhook_routing';

function fakeTwilioRequest(body: Record<string, string>): Request {
  return {
    headers: { 'x-tenant-id': TENANT_ID },
    body,
  } as unknown as Request;
}

async function cleanup() {
  await prisma.webhookReceipt.deleteMany({ where: { tenantId: TENANT_ID } });
  const conversations = await prisma.chatConversation.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length > 0) {
    await prisma.conversationSlot.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.chatMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
  }
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('Twilio webhook ack/dispatch split', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.tenant.upsert({
      where: { id: TENANT_ID },
      update: {},
      create: { id: TENANT_ID, name: 'Twilio Webhook Routing Test', province: 'BC' },
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('claims a fresh message fast, without running the bot', async () => {
    const req = fakeTwilioRequest({
      From: '+16045550111',
      To: '+16045550576',
      Body: 'Hi, is anyone there?',
      MessageSid: 'SM-fresh-1',
    });

    const claim = await claimAndPrepareTwilioMessage(req, 'sms');

    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('Expected claim to succeed');
    expect(claim.shouldProcess).toBe(true);
    if (!claim.shouldProcess) throw new Error('Expected shouldProcess to be true for a fresh message');
    expect(claim.job.tenantId).toBe(TENANT_ID);
    expect(claim.job.messageSid).toBe('SM-fresh-1');
    expect(claim.job.inbound.body).toBe('Hi, is anyone there?');

    const receipt = await prisma.webhookReceipt.findFirst({
      where: { tenantId: TENANT_ID, providerMessageId: 'SM-fresh-1' },
    });
    expect(receipt?.status).toBe('processing');
  });

  it('does not reprocess a message Twilio already delivered successfully (idempotent retry)', async () => {
    const req = fakeTwilioRequest({
      From: '+16045550111',
      Body: 'Retry me',
      MessageSid: 'SM-already-done',
    });

    const firstClaim = await claimAndPrepareTwilioMessage(req, 'sms');
    if (!firstClaim.ok || !firstClaim.shouldProcess) throw new Error('Expected first claim to be processable');
    await processClaimedTwilioMessage(firstClaim);

    const retryClaim = await claimAndPrepareTwilioMessage(req, 'sms');

    expect(retryClaim).toEqual({ ok: true, shouldProcess: false });
  });

  it('returns 409 for a message another request is still processing', async () => {
    const req = fakeTwilioRequest({
      From: '+16045550111',
      Body: 'Concurrent delivery',
      MessageSid: 'SM-concurrent',
    });

    const firstClaim = await claimAndPrepareTwilioMessage(req, 'sms');
    expect(firstClaim.ok).toBe(true);

    const secondClaim = await claimAndPrepareTwilioMessage(req, 'sms');

    expect(secondClaim).toEqual({
      ok: false,
      status: 409,
      error: 'Twilio message is still processing',
    });
  });

  it('rejects a payload missing required Twilio fields before ever touching the claim table', async () => {
    const req = fakeTwilioRequest({ From: '+16045550111' }); // sin Body ni MessageSid

    const claim = await claimAndPrepareTwilioMessage(req, 'sms');

    expect(claim).toEqual({
      ok: false,
      status: 400,
      error: 'From and Body are required; MessageSid is required',
    });
    const receiptCount = await prisma.webhookReceipt.count({ where: { tenantId: TENANT_ID } });
    expect(receiptCount).toBe(0);
  });

  it('processClaimedTwilioMessage runs the bot and marks the receipt completed — the exact slow path the webhook route no longer waits for', async () => {
    const req = fakeTwilioRequest({
      From: '+16045550111',
      Body: 'Hi',
      MessageSid: 'SM-completes',
    });
    const claim = await claimAndPrepareTwilioMessage(req, 'sms');
    if (!claim.ok || !claim.shouldProcess) throw new Error('Expected a processable claim');

    await processClaimedTwilioMessage(claim);

    const receipt = await prisma.webhookReceipt.findFirst({
      where: { tenantId: TENANT_ID, providerMessageId: 'SM-completes' },
    });
    expect(receipt?.status).toBe('completed');
    const conversation = await prisma.chatConversation.findFirst({
      where: { tenantId: TENANT_ID },
      include: { messages: true },
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.messages.length).toBeGreaterThan(0);
  });

  it('processClaimedTwilioMessage marks the receipt failed when the handler throws, without an HTTP response to report to', async () => {
    const req = fakeTwilioRequest({
      From: '+16045550111',
      Body: 'Hi',
      MessageSid: 'SM-fails',
    });
    const claim = await claimAndPrepareTwilioMessage(req, 'sms');
    if (!claim.ok || !claim.shouldProcess) throw new Error('Expected a processable claim');

    // Fuerza a handleInboundMessage a lanzar sin tocar tenantId/messageSid/
    // claimToken (failTwilioMessage necesita esos tres exactos para
    // encontrar y actualizar el recibo correcto): un canal fuera del enum
    // de Prisma revienta en el primer upsert de ChatConversation.
    const brokenClaim: Extract<TwilioClaimResult, { shouldProcess: true }> = {
      ...claim,
      job: { ...claim.job, channel: 'not-a-real-channel' as unknown as 'sms' },
    };

    await expect(processClaimedTwilioMessage(brokenClaim)).rejects.toThrow();

    const receipt = await prisma.webhookReceipt.findFirst({
      where: { tenantId: TENANT_ID, providerMessageId: 'SM-fails' },
    });
    expect(receipt?.status).toBe('failed');
  });
});

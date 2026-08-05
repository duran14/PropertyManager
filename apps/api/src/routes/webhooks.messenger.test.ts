import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';

/**
 * Mismo patrón que webhooks.twilio.test.ts: env mockeado con secretos de
 * prueba (no los de .env real), firma calculada igual que lo haría Meta,
 * para no depender de ni arriesgar credenciales/datos reales.
 */
const TENANT_ID = 'tenant_test_messenger_webhook_routing';
const TEST_APP_SECRET = 'test-only-messenger-app-secret';

vi.mock('../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env.js')>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      MESSENGER_APP_SECRET: TEST_APP_SECRET,
      MESSENGER_PAGE_ACCESS_TOKEN: '',
      MESSENGER_DEFAULT_TENANT_ID: TENANT_ID,
      MESSENGER_VERIFY_TOKEN: 'test-verify-token',
      ZAI_API_KEY: '',
    }),
  };
});

const {
  claimAndPrepareMessengerMessage,
  processClaimedMessengerMessage,
  resolveMessengerVerificationChallenge,
} = await import('./webhooks.js');

function messengerTextPayload(senderId: string, mid: string, text: string) {
  return {
    entry: [{ messaging: [{ sender: { id: senderId }, message: { mid, text } }] }],
  };
}

function signedMessengerRequest(body: object): Request {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = `sha256=${createHmac('sha256', TEST_APP_SECRET).update(rawBody).digest('hex')}`;
  return {
    headers: { 'x-hub-signature-256': signature },
    body,
    rawBody,
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

describe('Messenger webhook verification', () => {
  it('echoes the challenge when the verify token matches', () => {
    expect(resolveMessengerVerificationChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'challenge-123',
    })).toEqual({ status: 200, challenge: 'challenge-123' });
  });

  it('rejects a mismatched verify token', () => {
    expect(resolveMessengerVerificationChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge-123',
    })).toEqual({ status: 403 });
  });
});

describe('Messenger webhook ack/dispatch', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.tenant.upsert({
      where: { id: TENANT_ID },
      update: {},
      create: { id: TENANT_ID, name: 'Messenger Webhook Routing Test', province: 'BC' },
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('claims a fresh text message fast, without running the bot', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-1', 'mid-fresh-1', 'Hi, is anyone there?'));

    const claim = await claimAndPrepareMessengerMessage(req);

    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('Expected claim to succeed');
    expect(claim.shouldProcess).toBe(true);
    if (!claim.shouldProcess) throw new Error('Expected shouldProcess true for a fresh message');
    expect(claim.job.tenantId).toBe(TENANT_ID);
    expect(claim.job.mid).toBe('mid-fresh-1');
    expect(claim.job.inbound.body).toBe('Hi, is anyone there?');

    const receipt = await prisma.webhookReceipt.findFirst({
      where: { tenantId: TENANT_ID, providerMessageId: 'mid-fresh-1' },
    });
    expect(receipt?.status).toBe('processing');
  });

  it('rejects an invalid signature before touching the claim table', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-2', 'mid-bad-sig', 'Hello'));
    (req.headers as Record<string, string>)['x-hub-signature-256'] = 'sha256=deadbeef';

    const claim = await claimAndPrepareMessengerMessage(req);

    expect(claim).toEqual({ ok: false, status: 403, error: 'Invalid Messenger signature' });
    const receiptCount = await prisma.webhookReceipt.count({ where: { tenantId: TENANT_ID } });
    expect(receiptCount).toBe(0);
  });

  it('ignores an echo of the bot\'s own message without claiming anything', async () => {
    const req = signedMessengerRequest({
      entry: [{ messaging: [{ sender: { id: 'psid-3' }, message: { mid: 'mid-echo', text: 'hi', is_echo: true } }] }],
    });

    const claim = await claimAndPrepareMessengerMessage(req);

    expect(claim).toEqual({ ok: true, shouldProcess: false });
    const receiptCount = await prisma.webhookReceipt.count({ where: { tenantId: TENANT_ID } });
    expect(receiptCount).toBe(0);
  });

  it('does not reprocess a message already delivered successfully (idempotent retry)', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-4', 'mid-already-done', 'Retry me'));

    const firstClaim = await claimAndPrepareMessengerMessage(req);
    if (!firstClaim.ok || !firstClaim.shouldProcess) throw new Error('Expected first claim to be processable');
    await processClaimedMessengerMessage(firstClaim);

    const retryClaim = await claimAndPrepareMessengerMessage(req);

    expect(retryClaim).toEqual({ ok: true, shouldProcess: false });
  });

  it('returns 409 for a message another request is still processing', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-5', 'mid-concurrent', 'Concurrent delivery'));

    const firstClaim = await claimAndPrepareMessengerMessage(req);
    expect(firstClaim.ok).toBe(true);

    const secondClaim = await claimAndPrepareMessengerMessage(req);

    expect(secondClaim).toEqual({
      ok: false,
      status: 409,
      error: 'Messenger message is still processing',
    });
  });

  it('processClaimedMessengerMessage runs the bot and marks the receipt completed', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-6', 'mid-completes', 'Hi'));
    const claim = await claimAndPrepareMessengerMessage(req);
    if (!claim.ok || !claim.shouldProcess) throw new Error('Expected a processable claim');

    await processClaimedMessengerMessage(claim);

    const receipt = await prisma.webhookReceipt.findFirst({
      where: { tenantId: TENANT_ID, providerMessageId: 'mid-completes' },
    });
    expect(receipt?.status).toBe('completed');
    const conversation = await prisma.chatConversation.findFirst({
      where: { tenantId: TENANT_ID },
      include: { messages: true },
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.messages.length).toBeGreaterThan(0);
  });
});

import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { buildTwilioWebhookUrl } from '../services/twilio-webhook-security.service.js';

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
 *
 * La firma y el tenant de Twilio se validan con un TWILIO_AUTH_TOKEN/
 * TWILIO_DEFAULT_TENANT_ID de prueba (mockeados abajo), no con lo que haya
 * en el .env real del desarrollador: hasValidTwilioSignature/
 * getTwilioTenantId en webhooks.ts se comportan distinto según haya o no
 * credenciales reales configuradas, así que este test no puede depender de
 * eso — y menos aún arriesgarse a tocar el tenant demo real si algún día
 * TWILIO_DEFAULT_TENANT_ID coincidiera con uno real. TWILIO_ACCOUNT_SID y
 * ZAI_API_KEY se vacían explícitamente para que getAdapters() siga usando
 * los adapters mock (sin esto, un TWILIO_AUTH_TOKEN no vacío combinado con
 * el TWILIO_ACCOUNT_SID/ZAI_API_KEY reales del .env activaría los adapters
 * reales de Twilio/GLM y processClaimedTwilioMessage intentaría llamadas
 * de red reales).
 */

const TENANT_ID = 'tenant_test_twilio_webhook_routing';
const TEST_TWILIO_AUTH_TOKEN = 'test-only-twilio-auth-token';
const TEST_API_URL = 'https://pm-api.test.example.com';

vi.mock('../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env.js')>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      TWILIO_AUTH_TOKEN: TEST_TWILIO_AUTH_TOKEN,
      TWILIO_ACCOUNT_SID: '',
      TWILIO_DEFAULT_TENANT_ID: TENANT_ID,
      API_URL: TEST_API_URL,
      ZAI_API_KEY: '',
    }),
  };
});

const {
  claimAndPrepareTwilioMessage,
  processClaimedTwilioMessage,
} = await import('./webhooks.js');
type TwilioClaimResult = Awaited<ReturnType<typeof claimAndPrepareTwilioMessage>>;

function signTwilioRequest(path: string, body: Record<string, string>): string {
  const url = buildTwilioWebhookUrl(TEST_API_URL, path);
  const payload = Object.keys(body)
    .sort()
    .reduce((value, key) => value + key + body[key], url);
  return createHmac('sha1', TEST_TWILIO_AUTH_TOKEN).update(payload, 'utf8').digest('base64');
}

function fakeTwilioRequest(body: Record<string, string>): Request {
  const path = '/webhooks/twilio/sms';
  return {
    headers: {
      'x-tenant-id': TENANT_ID,
      'x-twilio-signature': signTwilioRequest(path, body),
    },
    originalUrl: path,
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

/**
 * Rutas de webhooks — puntos de entrada para integraciones externas.
 *
 * Estas rutas NO requieren JWT (se autentican por firma/secreto del webhook),
 * pero sí requieren el tenantId (vía header o path).
 *
 *  POST /webhooks/bank/e-transfer   — aviso de e-Transfer (banco o Plaid)
 *  POST /webhooks/buildium          — eventos de Buildium (Payment/Lease)
 *  POST /webhooks/twilio            — mensajes WhatsApp/SMS entrantes
 *  POST /webhooks/showmojo          - showing registrations and leads
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { InboundMessage } from '@property-manager/adapters';
import { bankNotificationQueue } from '../jobs/queues.js';
import { getAdapters } from '../config/adapters.js';
import { getEnv } from '../config/env.js';
import { handleInboundMessage } from '../services/chatbot.service.js';
import { createLeadFromShowMojo } from '../services/leads.service.js';
import {
  buildTwilioWebhookUrl,
  validateTwilioWebhookSignature,
} from '../services/twilio-webhook-security.service.js';
import { validateMessengerWebhookSignature } from '../services/messenger-webhook-security.service.js';
import { extractMessengerTextMessage } from '@property-manager/adapters';
import {
  claimWebhookMessage,
  completeWebhookMessage,
  failWebhookMessage,
} from '../services/webhook-receipt.service.js';

// Re-export para que el route de chat use el mismo helper.
export { getTenantId };

export const webhooksRouter = Router();

// En MVP, el tenant se identifica por header. En producción, cada tenant
// tendría su propia URL firmada.
function getTenantId(req: Request): string {
  const tenantId = req.headers['x-tenant-id'];
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new Error('x-tenant-id header is required');
  }
  return tenantId;
}

// --- Webhook de e-Transfer bancario ---
const eTransferSchema = z.object({
  amountCents: z.number().int().positive(),
  reference: z.string().min(1),
  senderName: z.string().optional(),
  receivedAt: z.string().datetime().or(z.string().date()).default(() => new Date().toISOString()),
});

webhooksRouter.post('/bank/e-transfer', async (req, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = eTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
      return;
    }
    await bankNotificationQueue.add('e-transfer', { tenantId, ...parsed.data });
    res.status(202).json({ status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// --- Webhook de Buildium (stub — parseo completo en Fase 6) ---
webhooksRouter.post('/buildium', async (req, res, next) => {
  try {
    const tenantId = getTenantId(req);
    console.log(`[Webhook] Buildium evento de tenant ${tenantId}:`, req.body?.type);
    res.status(202).json({ status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// --- Webhook de Twilio (WhatsApp/SMS entrantes) ---
//
// Las tres rutas de abajo (/twilio/sms, /twilio/whatsapp, /twilio genérica)
// comparten `acknowledgeAndDispatch`: reconocen a Twilio de inmediato — no
// esperan a que el bot piense. La respuesta real se entrega aparte, vía
// messagingAdapter.send() (llamada REST saliente a la API de Twilio) dentro
// de handleInboundMessage; nada de la respuesta depende de que esta
// conexión HTTP del webhook siga abierta. Con el modelo como intérprete
// principal, un solo turno puede tardar 6-15+ segundos — más de lo que
// Twilio espera antes de marcar el webhook como fallido. El claim se queda
// síncrono (escritura rápida a la BD) para que los reintentos de Twilio
// sigan deduplicándose antes de que nunca lleguemos a responder con ACK.
async function acknowledgeAndDispatch(
  req: Request,
  res: Response,
  channel: 'sms' | 'whatsapp',
): Promise<void> {
  const claim = await claimAndPrepareTwilioMessage(req, channel);
  if (!claim.ok) {
    res.status(claim.status).json({ error: claim.error });
    return;
  }
  sendTwilioWebhookAccepted(res);
  if (claim.shouldProcess) {
    void processClaimedTwilioMessage(claim).catch((err) => {
      console.error('[Twilio webhook] Background processing failed:', err);
    });
  }
}

webhooksRouter.post('/twilio/sms', async (req, res, next) => {
  try {
    await acknowledgeAndDispatch(req, res, 'sms');
  } catch (err) {
    next(err);
  }
});

webhooksRouter.post('/twilio/whatsapp', async (req, res, next) => {
  try {
    await acknowledgeAndDispatch(req, res, 'whatsapp');
  } catch (err) {
    next(err);
  }
});

webhooksRouter.post('/twilio', async (req, res, next) => {
  try {
    const from = typeof req.body?.From === 'string' ? req.body.From : '';
    const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    await acknowledgeAndDispatch(req, res, channel);
  } catch (err) {
    next(err);
  }
});

webhooksRouter.get('/messenger', (req, res) => {
  const result = resolveMessengerVerificationChallenge(req.query as Record<string, unknown>);
  if (result.status === 200) {
    res.status(200).type('text/plain').send(result.challenge);
    return;
  }
  res.status(result.status).end();
});

webhooksRouter.post('/messenger', async (req, res, next) => {
  try {
    await acknowledgeAndDispatchMessenger(req, res);
  } catch (err) {
    next(err);
  }
});

// --- ShowMojo webhook (showing registrations) ---
const showmojoSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  tourDate: z.string().optional(),
  unitId: z.string().optional(),
});

webhooksRouter.post('/showmojo', async (req, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const parsed = showmojoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }
    const result = await createLeadFromShowMojo({ tenantId, ...parsed.data });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export type TwilioClaimResult =
  | { ok: false; status: 400 | 403 | 409; error: string }
  | { ok: true; shouldProcess: false }
  | { ok: true; shouldProcess: true; job: ClaimedTwilioMessageJob };

export type ClaimedTwilioMessageJob = {
  tenantId: string;
  messageSid: string;
  claimToken: string;
  channel: 'sms' | 'whatsapp';
  inbound: InboundMessage;
  mediaUrls: string[] | undefined;
};

/**
 * Validates the request, deduplicates by MessageSid, and parses the
 * payload — everything that must finish before Twilio gets a response.
 * All of this is fast (signature check, DB claim, payload parsing); the
 * slow part (the bot actually thinking) happens in
 * processClaimedTwilioMessage, dispatched without being awaited here.
 */
export async function claimAndPrepareTwilioMessage(
  req: Request,
  channel: 'sms' | 'whatsapp',
): Promise<TwilioClaimResult> {
  if (!hasValidTwilioSignature(req)) {
    return { ok: false, status: 403, error: 'Invalid Twilio signature' };
  }

  if (!hasRequiredTwilioPayload(req.body)) {
    return { ok: false, status: 400, error: 'From and Body are required; MessageSid is required' };
  }

  const tenantId = getTwilioTenantId(req);
  const messageSid = (req.body as Record<string, string>).MessageSid;
  const claim = await claimWebhookMessage('twilio', tenantId, messageSid);
  if (claim.state === 'completed') {
    return { ok: true, shouldProcess: false };
  }
  if (claim.state === 'processing') {
    return { ok: false, status: 409, error: 'Twilio message is still processing' };
  }
  if (claim.state === 'failed') {
    return { ok: false, status: 409, error: 'Twilio message requires manual retry' };
  }

  const adapters = getAdapters();
  const messagingAdapter = channel === 'whatsapp' ? adapters.messaging.whatsapp : adapters.messaging.sms;
  try {
    const inbound = await messagingAdapter.parseWebhook(headersToRecord(req), req.body);
    return {
      ok: true,
      shouldProcess: true,
      job: {
        tenantId,
        messageSid,
        claimToken: claim.claimToken,
        channel,
        inbound,
        mediaUrls: collectTwilioMediaUrls(req.body),
      },
    };
  } catch (error) {
    await failWebhookMessage('twilio', tenantId, messageSid, claim.claimToken);
    throw error;
  }
}

/**
 * Runs the bot and delivers the reply. Deliberately NOT awaited by the
 * route handler — Twilio already has its 200 response. Owns its own
 * error handling: there is no HTTP request left to report failure to,
 * so a failure here must mark the receipt failed and log, not throw.
 */
export async function processClaimedTwilioMessage(
  claim: Extract<TwilioClaimResult, { shouldProcess: true }>,
): Promise<void> {
  const { tenantId, messageSid, claimToken, channel, inbound, mediaUrls } = claim.job;
  const adapters = getAdapters();
  const messagingAdapter = channel === 'whatsapp' ? adapters.messaging.whatsapp : adapters.messaging.sms;
  try {
    await handleInboundMessage(
      { tenantId, from: inbound.from, body: inbound.body, channel, mediaUrls },
      { glm: adapters.glm, messaging: messagingAdapter, showmojo: adapters.showmojo },
    );
    await completeWebhookMessage('twilio', tenantId, messageSid, claimToken);
  } catch (error) {
    await failWebhookMessage('twilio', tenantId, messageSid, claimToken);
    throw error;
  }
}

function hasRequiredTwilioPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const payload = body as Record<string, unknown>;
  return typeof payload.From === 'string' && payload.From.length > 0
    && typeof payload.Body === 'string' && payload.Body.length > 0
    && typeof payload.MessageSid === 'string' && payload.MessageSid.length > 0;
}

function getTwilioTenantId(req: Request): string {
  const env = getEnv();
  const tenantId = req.headers['x-tenant-id'];
  if (!env.TWILIO_AUTH_TOKEN && typeof tenantId === 'string' && tenantId) {
    return tenantId;
  }
  return env.TWILIO_DEFAULT_TENANT_ID;
}

function hasValidTwilioSignature(req: Request): boolean {
  const env = getEnv();
  if (!env.TWILIO_AUTH_TOKEN) {
    return true;
  }
  const signature = req.headers['x-twilio-signature'];
  if (typeof signature !== 'string' || !req.body || typeof req.body !== 'object') {
    return false;
  }
  return validateTwilioWebhookSignature({
    authToken: env.TWILIO_AUTH_TOKEN,
    url: buildTwilioWebhookUrl(env.API_URL, req.originalUrl),
    body: req.body as Record<string, unknown>,
    signature,
  });
}

function headersToRecord(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }
  return headers;
}

function collectTwilioMediaUrls(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const payload = body as Record<string, unknown>;
  const urls = Object.keys(payload)
    .filter((key) => /^MediaUrl\d+$/.test(key))
    .sort((a, b) => getTwilioMediaIndex(a) - getTwilioMediaIndex(b))
    .map((key) => payload[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return urls.length > 0 ? urls : undefined;
}

function getTwilioMediaIndex(key: string): number {
  return Number(key.replace('MediaUrl', ''));
}

function sendTwilioWebhookAccepted(res: Response): void {
  res.status(200).type('text/xml').send('<Response></Response>');
}

export function resolveMessengerVerificationChallenge(
  query: Record<string, unknown>,
): { status: 200; challenge: string } | { status: 403 | 404 } {
  const env = getEnv();
  if (!env.MESSENGER_VERIFY_TOKEN) {
    return { status: 404 };
  }
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === env.MESSENGER_VERIFY_TOKEN && typeof challenge === 'string') {
    return { status: 200, challenge };
  }
  return { status: 403 };
}

export type MessengerClaimResult =
  | { ok: false; status: 403 | 409; error: string }
  | { ok: true; shouldProcess: false }
  | { ok: true; shouldProcess: true; job: ClaimedMessengerMessageJob };

export type ClaimedMessengerMessageJob = {
  tenantId: string;
  mid: string;
  claimToken: string;
  inbound: InboundMessage;
};

function hasValidMessengerSignature(req: Request): boolean {
  const env = getEnv();
  if (!env.MESSENGER_APP_SECRET) {
    return true;
  }
  const signatureHeader = req.headers['x-hub-signature-256'];
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  return validateMessengerWebhookSignature({
    appSecret: env.MESSENGER_APP_SECRET,
    rawBody,
    signatureHeader: typeof signatureHeader === 'string' ? signatureHeader : undefined,
  });
}

/**
 * Igual que claimAndPrepareTwilioMessage: solo el trabajo rápido antes de
 * responderle a Meta (firma, extracción del mensaje, claim/dedup). A
 * diferencia de Twilio, el ID de dedup (`mid`) está anidado dentro del
 * payload — hay que parsearlo antes de poder reclamar.
 */
export async function claimAndPrepareMessengerMessage(req: Request): Promise<MessengerClaimResult> {
  if (!hasValidMessengerSignature(req)) {
    return { ok: false, status: 403, error: 'Invalid Messenger signature' };
  }

  const extracted = extractMessengerTextMessage(req.body);
  if (!extracted) {
    // Eco, adjunto, postback, o payload sin nada procesable: no es un
    // error — Meta debe seguir viendo 200, simplemente no hay nada que
    // reclamar ni procesar.
    return { ok: true, shouldProcess: false };
  }

  const env = getEnv();
  const tenantId = env.MESSENGER_DEFAULT_TENANT_ID;
  const claim = await claimWebhookMessage('messenger', tenantId, extracted.mid);
  if (claim.state === 'completed') {
    return { ok: true, shouldProcess: false };
  }
  if (claim.state === 'processing') {
    return { ok: false, status: 409, error: 'Messenger message is still processing' };
  }
  if (claim.state === 'failed') {
    return { ok: false, status: 409, error: 'Messenger message requires manual retry' };
  }

  return {
    ok: true,
    shouldProcess: true,
    job: {
      tenantId,
      mid: extracted.mid,
      claimToken: claim.claimToken,
      inbound: {
        from: extracted.senderId,
        body: extracted.text,
        channel: 'messenger',
        receivedAt: new Date().toISOString(),
        messageId: extracted.mid,
      },
    },
  };
}

/**
 * Igual que processClaimedTwilioMessage: corre el bot y entrega la
 * respuesta, sin bloquear la conexión HTTP del webhook (no se espera).
 */
export async function processClaimedMessengerMessage(
  claim: Extract<MessengerClaimResult, { shouldProcess: true }>,
): Promise<void> {
  const { tenantId, mid, claimToken, inbound } = claim.job;
  const adapters = getAdapters();
  try {
    await handleInboundMessage(
      { tenantId, from: inbound.from, body: inbound.body, channel: 'messenger' },
      { glm: adapters.glm, messaging: adapters.messaging.messenger, showmojo: adapters.showmojo },
    );
    await completeWebhookMessage('messenger', tenantId, mid, claimToken);
  } catch (error) {
    await failWebhookMessage('messenger', tenantId, mid, claimToken);
    throw error;
  }
}

async function acknowledgeAndDispatchMessenger(req: Request, res: Response): Promise<void> {
  const claim = await claimAndPrepareMessengerMessage(req);
  if (!claim.ok) {
    res.status(claim.status).json({ error: claim.error });
    return;
  }
  res.status(200).json({ status: 'received' });
  if (claim.shouldProcess) {
    void processClaimedMessengerMessage(claim).catch((err) => {
      console.error('[Messenger webhook] Background processing failed:', err);
    });
  }
}

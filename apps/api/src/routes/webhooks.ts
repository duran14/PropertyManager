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
import { bankNotificationQueue } from '../jobs/queues.js';
import { getAdapters } from '../config/adapters.js';
import { getEnv } from '../config/env.js';
import { handleInboundMessage } from '../services/chatbot.service.js';
import { createLeadFromShowMojo } from '../services/leads.service.js';
import {
  buildTwilioWebhookUrl,
  claimTwilioMessage,
  completeTwilioMessage,
  failTwilioMessage,
  validateTwilioWebhookSignature,
} from '../services/twilio-webhook-security.service.js';

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
webhooksRouter.post('/twilio/sms', async (req, res, next) => {
  try {
    const result = await processTwilioMessage(req, 'sms');
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    sendTwilioWebhookAccepted(res);
  } catch (err) {
    next(err);
  }
});

webhooksRouter.post('/twilio/whatsapp', async (req, res, next) => {
  try {
    const result = await processTwilioMessage(req, 'whatsapp');
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    sendTwilioWebhookAccepted(res);
  } catch (err) {
    next(err);
  }
});

webhooksRouter.post('/twilio', async (req, res, next) => {
  try {
    const from = typeof req.body?.From === 'string' ? req.body.From : '';
    const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const result = await processTwilioMessage(req, channel);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    sendTwilioWebhookAccepted(res);
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

async function processTwilioMessage(
  req: Request,
  channel: 'sms' | 'whatsapp',
): Promise<{ ok: true } | { ok: false; status: 400 | 403 | 409; error: string }> {
  if (!hasValidTwilioSignature(req)) {
    return { ok: false, status: 403, error: 'Invalid Twilio signature' };
  }

  if (!hasRequiredTwilioPayload(req.body)) {
    return { ok: false, status: 400, error: 'From and Body are required; MessageSid is required' };
  }

  const tenantId = getTwilioTenantId(req);
  const messageSid = (req.body as Record<string, string>).MessageSid;
  const claim = await claimTwilioMessage(tenantId, messageSid);
  if (claim.state === 'completed') {
    return { ok: true };
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
    await handleInboundMessage(
      {
        tenantId,
        from: inbound.from,
        body: inbound.body,
        channel,
        mediaUrls: collectTwilioMediaUrls(req.body),
      },
      { glm: adapters.glm, messaging: messagingAdapter, showmojo: adapters.showmojo },
    );
    await completeTwilioMessage(tenantId, messageSid, claim.claimToken);
    return { ok: true };
  } catch (error) {
    await failTwilioMessage(tenantId, messageSid, claim.claimToken);
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

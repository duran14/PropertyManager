/**
 * Rutas de webhooks — puntos de entrada para integraciones externas.
 *
 * Estas rutas NO requieren JWT (se autentican por firma/secreto del webhook),
 * pero sí requieren el tenantId (vía header o path).
 *
 *  POST /webhooks/bank/e-transfer   — aviso de e-Transfer (banco o Plaid)
 *  POST /webhooks/buildium          — eventos de Buildium (Payment/Lease)
 *  POST /webhooks/twilio            — mensajes WhatsApp/SMS entrantes
 *  POST /webhooks/showmojo          — registros de visita y leads
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { bankNotificationQueue } from '../jobs/queues.js';
import { getAdapters } from '../config/adapters.js';
import { handleInboundMessage } from '../services/chatbot.service.js';
import { createLeadFromShowMojo } from '../services/leads.service.js';

// Re-export para que el route de chat use el mismo helper.
export { getTenantId };

export const webhooksRouter = Router();

// En MVP, el tenant se identifica por header. En producción, cada tenant
// tendría su propia URL firmada.
function getTenantId(req: Request): string {
  const tenantId = req.headers['x-tenant-id'];
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new Error('Header x-tenant-id requerido');
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
      res.status(400).json({ error: 'Payload inválido', details: parsed.error.flatten() });
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
webhooksRouter.post('/twilio', async (req, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const { From, Body, MediaUrl0 } = req.body ?? {};
    if (!From || !Body) {
      res.status(400).json({ error: 'From y Body requeridos' });
      return;
    }
    const adapters = getAdapters();
    const channel = From.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const from = From.replace('whatsapp:', '');
    const mediaUrls = MediaUrl0 ? [MediaUrl0] : undefined;

    const messagingAdapter = channel === 'whatsapp' ? adapters.messaging.whatsapp : adapters.messaging.sms;
    await handleInboundMessage(
      { tenantId, from, body: Body, channel, mediaUrls },
      { glm: adapters.glm, messaging: messagingAdapter, showmojo: adapters.showmojo },
    );
    res.status(200).json({ status: 'processed' });
  } catch (err) {
    next(err);
  }
});

// --- Webhook de ShowMojo (registros de visita) ---
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
      res.status(400).json({ error: 'Payload inválido' });
      return;
    }
    const result = await createLeadFromShowMojo({ tenantId, ...parsed.data });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

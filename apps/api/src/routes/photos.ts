/**
 * Rutas de Fotos IA (Módulo A — Fase 8).
 *
 *  POST /units/:unitId/photos           — registra una foto subida
 *  GET  /units/:unitId/photos           — lista fotos de una unidad
 *  POST /photos/:photoId/enhance        — solicita mejora IA (enhance/declutter/staging)
 *  POST /webhooks/autoenhance           — webhook de Autoenhance.ai
 */
import { Router } from 'express';
import { z } from 'zod';
import { getAdapters } from '../config/adapters.js';
import { prisma } from '../config/db.js';
import { requireAuth, requireUser } from '../auth/context.js';
import {
  handleEnhancementComplete,
  listUnitPhotos,
  requestEnhancement,
  uploadPhoto,
} from '../services/photos.service.js';

export const photosRouter = Router();

const uploadSchema = z.object({
  originalUrl: z.string().url(),
  isPrimary: z.boolean().optional(),
});

photosRouter.post('/units/:unitId/photos', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'URL inválida', details: parsed.error.flatten() });
      return;
    }
    // Verificar que la unidad pertenece al tenant.
    const unit = await prisma.unit.findFirst({
      where: { id: req.params.unitId, tenantId: user.tenantId },
    });
    if (!unit) {
      res.status(404).json({ error: 'Unidad no encontrada' });
      return;
    }
    const photo = await uploadPhoto({
      tenantId: user.tenantId,
      unitId: req.params.unitId,
      originalUrl: parsed.data.originalUrl,
      isPrimary: parsed.data.isPrimary,
      uploadedByUserId: user.userId,
    });
    res.status(201).json(photo);
  } catch (err) {
    next(err);
  }
});

photosRouter.get('/units/:unitId/photos', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const photos = await listUnitPhotos(user.tenantId, req.params.unitId);
    res.json({ photos });
  } catch (err) {
    next(err);
  }
});

const enhanceSchema = z.object({
  enhancementType: z.enum(['enhance', 'object_removal', 'virtual_staging']),
  style: z.string().optional(),
});

photosRouter.post('/photos/:photoId/enhance', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = enhanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Tipo de mejora inválido', details: parsed.error.flatten() });
      return;
    }
    const adapters = getAdapters();
    const result = await requestEnhancement(
      {
        photoId: req.params.photoId,
        tenantId: user.tenantId,
        enhancementType: parsed.data.enhancementType,
        style: parsed.data.style,
        requestedByUserId: user.userId,
      },
      adapters.photoEnhancement,
    );
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

// Webhook de Autoenhance.ai (sin auth — se identifica por orderId).
photosRouter.post('/webhooks/autoenhance', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId !== 'string') {
      res.status(400).json({ error: 'Header x-tenant-id requerido' });
      return;
    }
    const adapters = getAdapters();
    const event = await adapters.photoEnhancement.parseWebhook(
      req.headers as Record<string, string>,
      req.body,
    );
    await handleEnhancementComplete({
      tenantId,
      orderId: event.orderId,
      enhancedUrl: event.enhancedUrl,
      status: event.status,
    });
    res.status(200).json({ status: 'processed' });
  } catch (err) {
    next(err);
  }
});

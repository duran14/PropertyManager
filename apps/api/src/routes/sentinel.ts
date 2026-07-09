/**
 * Rutas del Financial Sentinel.
 *
 *  POST /sentinel/reconcile        — dispara reconciliación inmediata (encola)
 *  POST /sentinel/process-payment  — simula procesar un e-Transfer (dev/test)
 *  GET  /sentinel/schedule         — schedulea el job diario recurrente
 *  GET  /sentinel/status           — estado de las colas (jobs activos/pendientes)
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import {
  bankNotificationQueue,
  reconciliationQueue,
  scheduleDailyReconciliation,
} from '../jobs/queues.js';

export const sentinelRouter = Router();

const reconcileSchema = z.object({
  runDate: z.string().optional(),
});

sentinelRouter.post('/reconcile', requireAuth, requireRole('bookkeeper', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = reconcileSchema.safeParse(req.body ?? {});
    const runDate = parsed.success && parsed.data.runDate ? parsed.data.runDate : new Date().toISOString();
    const job = await reconciliationQueue.add('manual-reconciliation', {
      tenantId: user.tenantId,
      runDate,
      triggeredBy: 'manual',
    });
    res.status(202).json({ jobId: job.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

const paymentSchema = z.object({
  amountCents: z.number().int().positive(),
  reference: z.string().min(1),
  senderName: z.string().optional(),
});

sentinelRouter.post('/process-payment', requireAuth, requireRole('bookkeeper', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Payload inválido', details: parsed.error.flatten() });
      return;
    }
    const job = await bankNotificationQueue.add('e-transfer', {
      tenantId: user.tenantId,
      ...parsed.data,
      receivedAt: new Date().toISOString(),
    });
    res.status(202).json({ jobId: job.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

sentinelRouter.get('/schedule', requireAuth, requireRole('property_manager', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    await scheduleDailyReconciliation(user.tenantId);
    res.json({ status: 'scheduled', cron: '0 6 * * *', tz: 'America/Vancouver' });
  } catch (err) {
    next(err);
  }
});

sentinelRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [reconJobs, bankJobs] = await Promise.all([
      reconciliationQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
      bankNotificationQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
    ]);
    // Jobs recientes del tenant (audit trail del sentinel).
    const recentSentinelActions = await prisma.auditEntry.findMany({
      where: { tenantId: user.tenantId, actorId: 'sentinel_agent' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { action: true, occurredAt: true, payload: true },
    });
    res.json({
      queues: {
        reconciliation: reconJobs,
        bankNotification: bankJobs,
      },
      recentActions: recentSentinelActions,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Rutas de auditoría y borradores RTA (Módulo D).
 *
 *  GET  /audit/trail          — lista el audit trail (filtrable)
 *  POST /audit/verify-chain   — verifica integridad de la cadena
 *  POST /audit/rta/draft      — genera borrador RTA-BC para un lease
 *  POST /audit/rta/sign       — broker firma el borrador
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import { listAuditTrail, verifyAuditChain } from '../services/audit-verify.service.js';
import { generateRtaDraft, signRtaDraft } from '../services/rta.service.js';

export const auditRouter = Router();

auditRouter.get('/trail', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const entries = await listAuditTrail(user.tenantId, {
      actorType: typeof req.query.actorType === 'string' ? req.query.actorType : undefined,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      entityType: typeof req.query.entityType === 'string' ? req.query.entityType : undefined,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    res.json({ entries, count: entries.length });
  } catch (err) {
    next(err);
  }
});

auditRouter.post(
  '/verify-chain',
  requireAuth,
  requireRole('bookkeeper', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const result = await verifyAuditChain(user.tenantId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

const draftSchema = z.object({ leaseId: z.string() });

auditRouter.post('/rta/draft', requireAuth, requireRole('property_manager', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = draftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'leaseId requerido' });
      return;
    }
    const draft = await generateRtaDraft({
      leaseId: parsed.data.leaseId,
      tenantId: user.tenantId,
      generatedByUserId: user.userId,
    });
    res.json(draft);
  } catch (err) {
    next(err);
  }
});

const signSchema = z.object({ leaseId: z.string(), signedDocRef: z.string() });

auditRouter.post('/rta/sign', requireAuth, requireRole('broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = signSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'leaseId y signedDocRef requeridos' });
      return;
    }
    await signRtaDraft(parsed.data.leaseId, user.tenantId, user.userId, parsed.data.signedDocRef);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

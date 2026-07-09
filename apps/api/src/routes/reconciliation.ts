/**
 * Rutas de reconciliación (Módulo C/D).
 *
 *  POST /reconciliation/run   — ejecuta el matching diario (job manual o trigger)
 *  GET  /reconciliation/batches — historial de batches
 *  GET  /reconciliation/discrepancies — discrepancias pendientes
 *  POST /reconciliation/discrepancies/:id/resolve — marcar resuelta
 */
import { Router } from 'express';
import { getAdapters } from '../config/adapters.js';
import { prisma } from '../config/db.js';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import {
  listDiscrepancies,
  resolveDiscrepancy,
  runReconciliation,
} from '../services/reconciliation.service.js';

export const reconciliationRouter = Router();

reconciliationRouter.post('/run', requireAuth, requireRole('bookkeeper', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const adapters = getAdapters();
    const runDate = req.body?.date ? new Date(req.body.date as string) : new Date();
    const result = await runReconciliation(user.tenantId, runDate, {
      qbo: adapters.qbo,
      plaid: adapters.plaid,
      plaidItemId: 'item_demo', // MVP: un item por tenant; configurable después
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

reconciliationRouter.get('/batches', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const batches = await prisma.reconciliationBatch.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { runDate: 'desc' },
      take: 30,
    });
    res.json({ batches });
  } catch (err) {
    next(err);
  }
});

reconciliationRouter.get('/discrepancies', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const resolved =
      req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : undefined;
    const discrepancies = await listDiscrepancies(user.tenantId, { resolved });
    res.json({ discrepancies });
  } catch (err) {
    next(err);
  }
});

reconciliationRouter.post(
  '/discrepancies/:id/resolve',
  requireAuth,
  requireRole('bookkeeper', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      await resolveDiscrepancy(req.params.id, user.tenantId, user.userId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

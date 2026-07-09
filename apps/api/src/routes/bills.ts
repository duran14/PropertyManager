/**
 * Rutas del Puente Contable (Módulo C).
 *
 *  POST /bills/process-receipt  — sube un recibo, OCR + confidence + HITL
 *  GET  /bills                  — lista bills (filtrable por estado)
 *  GET  /bills/:id              — detalle de un bill
 *  POST /bills/:id/approve      — aprueba un bill HITL (bookkeeper/broker)
 *  POST /bills/:id/reject       — rechaza un bill HITL (bookkeeper/broker)
 */
import { Router } from 'express';
import { z } from 'zod';
import { getAdapters } from '../config/adapters.js';
import { prisma } from '../config/db.js';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import { approveBill, processReceipt, rejectBill } from '../services/bills.service.js';

export const billsRouter = Router();

const receiptSchema = z.object({
  mimeType: z.string().min(5),
  base64: z.string().min(10),
  filename: z.string().optional(),
  unitId: z.string().optional(),
});

billsRouter.post('/process-receipt', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = receiptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Recibo inválido', details: parsed.error.flatten() });
      return;
    }

    const adapters = getAdapters();
    const result = await processReceipt(
      {
        tenantId: user.tenantId,
        actorId: user.userId,
        mimeType: parsed.data.mimeType,
        base64: parsed.data.base64,
        filename: parsed.data.filename,
        unitId: parsed.data.unitId,
      },
      { glm: adapters.glm, qbo: adapters.qbo },
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

billsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const bills = await prisma.bill.findMany({
      where: { tenantId: user.tenantId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { approvalRequest: true },
    });
    res.json({ bills });
  } catch (err) {
    next(err);
  }
});

billsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const bill = await prisma.bill.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
      include: { approvalRequest: true },
    });
    if (!bill) {
      res.status(404).json({ error: 'Bill no encontrado' });
      return;
    }
    res.json({ bill });
  } catch (err) {
    next(err);
  }
});

const noteSchema = z.object({ note: z.string().max(500).optional() });

billsRouter.post(
  '/:id/approve',
  requireAuth,
  requireRole('bookkeeper', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const parsed = noteSchema.safeParse(req.body);
      const adapters = getAdapters();
      const result = await approveBill(
        req.params.id,
        user.tenantId,
        user.userId,
        { qbo: adapters.qbo },
        parsed.success ? parsed.data.note : undefined,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

billsRouter.post(
  '/:id/reject',
  requireAuth,
  requireRole('bookkeeper', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const parsed = noteSchema.safeParse(req.body);
      await rejectBill(
        req.params.id,
        user.tenantId,
        user.userId,
        parsed.success ? parsed.data.note : undefined,
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

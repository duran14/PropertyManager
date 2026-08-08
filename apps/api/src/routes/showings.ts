/**
 * Showings routes.
 *
 *  GET  /showings              - list showings, optionally filtered by status
 *  GET  /showings/:id          - showing detail
 *  POST /showings/:id/confirm  - broker confirms the showing
 *  POST /showings/:id/cancel   - cancel a showing
 *  POST /showings/:id/complete - broker marks the showing as done; invites the application
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import { getAdapters } from '../config/adapters.js';
import { prisma } from '../config/db.js';
import {
  cancelShowing,
  confirmShowing,
  listShowings,
} from '../services/scheduling.service.js';
import { completeShowingAndInvite } from '../services/rental-application.service.js';

export const showingsRouter = Router();

showingsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const showings = await listShowings(user.tenantId, { status });
    res.json({ showings });
  } catch (err) {
    next(err);
  }
});

showingsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const showings = await listShowings(user.tenantId, {});
    const showing = showings.find((s) => s.id === req.params.id);
    if (!showing) {
      res.status(404).json({ error: 'Showing not found' });
      return;
    }
    res.json({ showing });
  } catch (err) {
    next(err);
  }
});

showingsRouter.post(
  '/:id/confirm',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      await confirmShowing(req.params.id, user.tenantId, user.userId);
      res.json({ status: 'confirmed' });
    } catch (err) {
      next(err);
    }
  },
);

showingsRouter.post(
  '/:id/complete',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const result = await completeShowingAndInvite(
        { showingId: req.params.id, tenantId: user.tenantId, actorUserId: user.userId },
        { messaging: getAdapters().messaging },
      );
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        status: 'completed',
        applicationId: result.applicationId,
        applicationUrl: result.applicationUrl,
        linkDelivered: result.linkDelivered,
      });
    } catch (err) {
      next(err);
    }
  },
);

const cancelSchema = z.object({ reason: z.string().max(500).optional() });

showingsRouter.post(
  '/:id/cancel',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const parsed = cancelSchema.safeParse(req.body ?? {});
      await cancelShowing(
        req.params.id,
        user.tenantId,
        user.userId,
        parsed.success ? parsed.data.reason : undefined,
      );
      res.json({ status: 'cancelled' });
    } catch (err) {
      next(err);
    }
  },
);

showingsRouter.get('/:id/application', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    // `select` explícito: nunca proyectar `tokenHash` fuera de este
    // servicio, aunque sea solo un hash y no directamente explotable.
    const application = await prisma.rentalApplication.findFirst({
      where: { showingId: req.params.id, tenantId: user.tenantId },
      select: {
        id: true,
        status: true,
        annualIncome: true,
        employerName: true,
        references: true,
        applicantFullName: true,
        idDocumentStorageKey: true,
        consentApplicationAt: true,
        consentCreditCheckAt: true,
        consentPoliceCheckAt: true,
        submittedAt: true,
        createdAt: true,
      },
    });
    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.json({ application });
  } catch (err) {
    next(err);
  }
});

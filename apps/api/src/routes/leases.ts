/**
 * Rutas de Leases / Contratos.
 *
 *  GET /leases          — lista contratos de un tenant
 */
import { Router } from 'express';
import { prisma } from '../config/db.js';
import { requireAuth, requireUser } from '../auth/context.js';

export const leasesRouter = Router();

leasesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const leases = await prisma.lease.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        unit: { include: { property: { select: { name: true, city: true } } } },
        tenantRecord: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    res.json({ leases });
  } catch (err) {
    next(err);
  }
});

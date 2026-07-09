/**
 * Rutas de Unidades y Propiedades.
 *
 *  GET /units          — lista unidades del tenant (con propiedad)
 *  GET /units/:id      — detalle de una unidad
 */
import { Router } from 'express';
import { prisma } from '../config/db.js';
import { requireAuth, requireUser } from '../auth/context.js';

export const unitsRouter = Router();

unitsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const units = await prisma.unit.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      include: { property: { select: { name: true, city: true, address: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ units });
  } catch (err) {
    next(err);
  }
});

unitsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const unit = await prisma.unit.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
      include: { property: true },
    });
    if (!unit) {
      res.status(404).json({ error: 'Unidad no encontrada' });
      return;
    }
    res.json({ unit });
  } catch (err) {
    next(err);
  }
});

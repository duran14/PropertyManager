/**
 * Read-only owners endpoint.
 *
 *  GET /owners — list tenant owners, so Properties can offer an
 *  owner picker (see PropertiesPage.tsx). Fase 3 (owner statements)
 *  only needs to link a Property to an Owner; creating/editing/deleting
 *  owners is out of scope here and belongs to a later phase.
 */
import { Router } from 'express';
import { prisma } from '../config/db.js';
import { requireAuth, requireUser } from '../auth/context.js';

export const ownersRouter = Router();

ownersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const owners = await prisma.owner.findMany({
      where: { tenantId: user.tenantId },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    res.json({ owners });
  } catch (err) {
    next(err);
  }
});

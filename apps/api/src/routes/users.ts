import { Router } from 'express';
import { requireAuth, requireUser } from '../auth/context.js';
import { prisma } from '../config/db.js';

export const usersRouter = Router();

usersRouter.get('/staff', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const users = await prisma.user.findMany({
      where: { tenantId: user.tenantId, isActive: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
    });
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

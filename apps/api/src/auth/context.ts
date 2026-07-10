/**
 * Authentication context: who the user is and which tenant they belong to.
 *
 * Attached to req.user after JWT verification. Every DB query must filter by
 * req.user.tenantId; this is the first layer of tenant isolation. RLS in
 * Postgres is the second layer.
 */
import type { UserRole } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

export interface AuthUser {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

/**
 * Authenticated request: guarantees req.user is present.
 * Use this in handlers that already passed through requireAuth.
 */
export type AuthedRequest = Request & { user: AuthUser };

/** Type guard: is the request authenticated? Throws when it is not. */
export function requireUser(req: Request): AuthUser {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) {
    throw new Error('req.user is not defined; auth middleware is missing');
  }
  return user;
}

/** Middleware: the route requires an authenticated user. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}

/** Middleware factory: the route requires one of the provided roles. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

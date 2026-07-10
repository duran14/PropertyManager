/**
 * Middleware de autenticación.
 *
 * Extrae el access token del header Authorization (Bearer), lo verifica y
 * attaches the payload to req.user. If missing or invalid, leaves req.user
 * undefined para que los middlewares de ruta (requireAuth/requireRole) decidan.
 *
 * El refresh token va aparte, en cookie httpOnly, y se gestiona en /auth/refresh.
 */
import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from './jwt.js';
import type { AuthUser } from './context.js';

/**
 * Middleware de autenticación.
 *
 * Extrae el access token del header Authorization (Bearer), lo verifica y
 * attaches the payload to req.user. If missing or invalid, leaves req.user
 * undefined para que los middlewares de ruta (requireAuth/requireRole) decidan.
 *
 * El refresh token va aparte, en cookie httpOnly, y se gestiona en /auth/refresh.
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = verifyAccessToken(token);
    const user: AuthUser = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
      email: payload.email,
    };
    (req as Request & { user?: AuthUser }).user = user;
  } catch {
    // Invalid or expired token: leave the request without a user; requireAuth returns 401.
    (req as Request & { user?: AuthUser }).user = undefined;
  }
  next();
}

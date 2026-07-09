/**
 * Contexto de autenticación: quién es el usuario y a qué tenant pertenece.
 *
 * Se adjunta a req.user tras verificar el JWT. Toda consulta a la BD DEBE
 * filtrar por req.user.tenantId — esto es la primera capa de aislamiento
 * multi-tenant. La segunda capa es RLS en Postgres.
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
 * Request autenticada: garantiza que req.user está presente.
 * Úsalo en los handlers que ya pasaron por requireAuth.
 */
export type AuthedRequest = Request & { user: AuthUser };

/** Type guard: ¿la petición está autenticada? Lanza si no. */
export function requireUser(req: Request): AuthUser {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) {
    throw new Error('req.user no definido — falta middleware de auth');
  }
  return user;
}

/** Middleware: la ruta requiere usuario autenticado. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }
  next();
}

/** Middleware factory: la ruta requiere uno de los roles indicados. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: 'Permisos insuficientes' });
      return;
    }
    next();
  };
}

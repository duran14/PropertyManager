/**
 * Emisión y verificación de JWT (access + refresh).
 *
 * Access token: corto (15m), va en Authorization header.
 * Refresh token: largo (7d), va en cookie httpOnly para mitigar XSS.
 */
import type { UserRole } from '@prisma/client';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { getEnv } from '../config/env.js';

export interface TokenPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

interface DecodedToken extends JwtPayload, TokenPayload {}

export function signAccessToken(payload: TokenPayload): string {
  const env = getEnv();
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as unknown as number,
  });
}

export function signRefreshToken(payload: TokenPayload): string {
  const env = getEnv();
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as unknown as number,
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as DecodedToken;
  return extractPayload(decoded);
}

export function verifyRefreshToken(token: string): TokenPayload {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as DecodedToken;
  return extractPayload(decoded);
}

function extractPayload(decoded: DecodedToken): TokenPayload {
  return {
    userId: decoded.userId,
    tenantId: decoded.tenantId,
    role: decoded.role,
    email: decoded.email,
  };
}

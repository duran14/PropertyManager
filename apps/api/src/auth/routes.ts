/**
 * Authentication routes: login, refresh, logout, me.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { requireAuth, requireUser } from './context.js';
import { authMiddleware } from './middleware.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './jwt.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid credentials', details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email },
    include: { tenant: true },
  });

  // Keep the same timing for missing users and wrong passwords to reduce enumeration risk.
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const payload = {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    email: user.email,
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const env = getEnv();
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  res.json({
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
      tenantName: user.tenant.name,
    },
  });
});

authRouter.post('/refresh', async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    res.status(401).json({ error: 'Refresh token required' });
    return;
  }

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    res.status(401).json({ error: 'Refresh token is invalid or expired' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || !user.isActive) {
    res.status(401).json({ error: 'User is not valid' });
    return;
  }

  const newPayload = {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    email: user.email,
  };
  res.json({ accessToken: signAccessToken(newPayload) });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('refreshToken', { path: '/auth' });
  res.status(204).end();
});

authRouter.get('/me', authMiddleware, requireAuth, async (req, res) => {
  const user = requireUser(req);
  const full = await prisma.user.findUnique({
    where: { id: user.userId },
    include: { tenant: true },
  });
  if (!full) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({
    id: full.id,
    email: full.email,
    firstName: full.firstName,
    lastName: full.lastName,
    role: full.role,
    tenantId: full.tenantId,
    tenantName: full.tenant.name,
  });
});

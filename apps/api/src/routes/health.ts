/** Ruta de health check — verifica que la API y la BD responden. */
import { Router } from 'express';
import { prisma } from '../config/db.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    // Ping simple a la BD.
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', error: 'database_unreachable' });
  }
});

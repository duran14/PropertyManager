/**
 * Express app with middleware and route mounting.
 * Kept separate from server.ts to make testing easier.
 */
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { getEnv } from './config/env.js';
import { authMiddleware } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { healthRouter } from './routes/health.js';
import { billsRouter } from './routes/bills.js';
import { reconciliationRouter } from './routes/reconciliation.js';
import { webhooksRouter } from './routes/webhooks.js';
import { sentinelRouter } from './routes/sentinel.js';
import { auditRouter } from './routes/audit.js';
import { leadsRouter, publicRouter } from './routes/leads.js';
import { leasesRouter } from './routes/leases.js';
import { photosRouter } from './routes/photos.js';
import { unitsRouter } from './routes/units.js';
import { chatRouter } from './routes/chat.js';
import { showingsRouter } from './routes/showings.js';

export function createApp(): express.Application {
  const env = getEnv();
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_URL,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // Global auth middleware: populates req.user when a valid token is present.
  app.use(authMiddleware);

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/bills', billsRouter);
  app.use('/reconciliation', reconciliationRouter);
  app.use('/sentinel', sentinelRouter);
  app.use('/webhooks', webhooksRouter);
  app.use('/audit', auditRouter);
  app.use('/leads', leadsRouter);
  app.use('/leases', leasesRouter);
  app.use('/units', unitsRouter);
  app.use('/photos', photosRouter);
  app.use('/chat', chatRouter);
  app.use('/showings', showingsRouter);
  app.use('/public', publicRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal error';
    if (env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'Internal error' });
    } else {
      res.status(500).json({ error: message });
    }
  });

  return app;
}

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
import { propertiesRouter } from './routes/properties.js';
import { ownersRouter } from './routes/owners.js';
import { onboardingRouter } from './routes/onboarding.js';
import { documentsRouter } from './routes/documents.js';
import { knowledgeBaseRouter } from './routes/knowledge-base.js';
import { usersRouter } from './routes/users.js';
import { webhookConfigRouter } from './routes/webhook-config.js';
import { googleCalendarRouter } from './routes/integrations.google-calendar.js';
import { integrationsRouter } from './routes/integrations.js';

/**
 * body-parser marca los errores de JSON.parse con `type ===
 * 'entity.parse.failed'` (verificado empíricamente contra la versión
 * instalada). Es la única señal fiable para distinguirlos de cualquier otro
 * error — el texto de err.message varía por versión de Node/V8 y no hay que
 * confiar en su forma.
 */
function isJsonBodyParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  );
}

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
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: false }));
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
  app.use('/properties', propertiesRouter);
  app.use('/owners', ownersRouter);
  app.use('/onboarding', onboardingRouter);
  app.use('/documents', documentsRouter);
  app.use('/knowledge-base', knowledgeBaseRouter);
  app.use('/users', usersRouter);
  app.use('/webhook-config', webhookConfigRouter);
  app.use('/photos', photosRouter);
  app.use('/chat', chatRouter);
  app.use('/showings', showingsRouter);
  app.use('/integrations/google-calendar', googleCalendarRouter);
  // Montado DESPUÉS del router de google-calendar: Express hace prefix-match
  // en orden de registro, así que la ruta específica se queda con
  // /integrations/google-calendar/* antes de que esta genérica la vea.
  app.use('/integrations', integrationsRouter);
  app.use('/public', publicRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // express.json() (body-parser) falla el parseo ANTES de que cualquier
    // route handler corra, y su err.message puede embeber un fragmento
    // crudo del body — que para rutas como POST /integrations puede ser una
    // contraseña en claro que el usuario acaba de escribir. Se corta acá,
    // antes de la rama de abajo que hace echo de err.message en no-prod.
    if (isJsonBodyParseError(err)) {
      res.status(400).json({ error: 'Invalid JSON in request body' });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal error';
    if (env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'Internal error' });
    } else {
      res.status(500).json({ error: message });
    }
  });

  return app;
}

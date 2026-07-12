import { Router } from 'express';
import { requireAuth } from '../auth/context.js';
import { getEnv } from '../config/env.js';
import { buildWebhookTargets } from '../services/webhook-config.service.js';

export const webhookConfigRouter = Router();

webhookConfigRouter.get('/', requireAuth, (_req, res) => {
  const env = getEnv();
  res.json({
    apiUrl: env.API_URL,
    targets: buildWebhookTargets(env.API_URL),
    note: 'Use these URLs after deploying the API to a stable public host.',
  });
});

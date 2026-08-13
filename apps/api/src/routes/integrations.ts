import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import {
  listIntegrationStatuses,
  saveIntegrationCredentials,
  type ScreeningProvider,
} from '../services/integration-vault.service.js';

export const integrationsRouter = Router();

const SCREENING_PROVIDERS: ScreeningProvider[] = ['frontlobby_portal', 'sterling_portal'];

const saveSchema = z.object({
  provider: z.enum(['frontlobby_portal', 'sterling_portal']),
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

integrationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const statuses = await listIntegrationStatuses(user.tenantId);
    // Siempre se listan los dos proveedores conocidos, con 'not_configured'
    // para el que todavía no tiene fila — así la UI no tiene que inferir
    // ausencia de configuración.
    const byProvider = new Map(statuses.map((entry) => [entry.provider, entry]));
    res.json({
      integrations: SCREENING_PROVIDERS.map((provider) => byProvider.get(provider) ?? {
        provider, status: 'not_configured', lastSyncedAt: null,
      }),
    });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.post('/', requireAuth, requireRole('property_manager'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid credentials payload' });
      return;
    }
    await saveIntegrationCredentials({ tenantId: user.tenantId, ...parsed.data });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

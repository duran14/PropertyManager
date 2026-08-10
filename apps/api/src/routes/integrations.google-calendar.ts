/**
 * Conexión de la agencia con Google Calendar.
 *
 * El callback es la ÚNICA ruta pública del router: Google redirige el
 * navegador ahí sin garantía de que lleve nuestra cookie de sesión. Su
 * autenticación es el `state` firmado, no la sesión.
 */
import { Router } from 'express';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import { getEnv } from '../config/env.js';
import {
  disconnectCalendar,
  getCalendarConnectionStatus,
  resolveRedirectUri,
  saveCalendarConnection,
  signOAuthState,
  verifyOAuthState,
} from '../services/calendar-connection.service.js';
import {
  getSchedulingConfig,
  updateSchedulingConfig,
} from '../services/scheduling-config.service.js';

export const googleCalendarRouter = Router();

googleCalendarRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [status, config] = await Promise.all([
      getCalendarConnectionStatus(user.tenantId),
      getSchedulingConfig(user.tenantId),
    ]);
    res.json({ ...status, config });
  } catch (err) {
    next(err);
  }
});

googleCalendarRouter.post(
  '/authorize',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { getAdapters } = await import('../config/adapters.js');
      const authorizeUrl = getAdapters().calendar.buildAuthorizeUrl({
        redirectUri: resolveRedirectUri(),
        state: signOAuthState({ tenantId: user.tenantId, userId: user.userId }),
      });
      res.json({ authorizeUrl });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * La lógica del callback vive fuera del handler para poder probarla directo,
 * como `claimAndPrepareMessengerMessage` en routes/webhooks.ts. El handler
 * queda como un mapeo a redirecciones.
 */
export type CompleteConnectionResult =
  | { ok: true; accountEmail: string }
  | { ok: false; reason: string };

export async function completeGoogleCalendarConnection(input: {
  code: string;
  state: string;
}): Promise<CompleteConnectionResult> {
  if (!input.code) return { ok: false, reason: 'missing_code' };

  const verified = verifyOAuthState(input.state);
  if (!verified.ok) return { ok: false, reason: `invalid_state_${verified.reason}` };

  try {
    const { getAdapters } = await import('../config/adapters.js');
    const calendar = getAdapters().calendar;
    const tokens = await calendar.exchangeAuthorizationCode({
      code: input.code,
      redirectUri: resolveRedirectUri(),
    });
    const config = await getSchedulingConfig(verified.tenantId);
    const { calendarId } = await calendar.ensureShowingsCalendar({
      accessToken: tokens.accessToken,
      timeZone: config.timeZone,
    });

    await saveCalendarConnection({
      tenantId: verified.tenantId,
      accountEmail: tokens.accountEmail,
      showingsCalendarId: calendarId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresInSeconds: tokens.expiresInSeconds,
    });

    return { ok: true, accountEmail: tokens.accountEmail };
  } catch {
    // No se propaga: un 500 en el navegador del manager no le dice nada.
    // Se le regresa a la app con el motivo.
    return { ok: false, reason: 'exchange_failed' };
  }
}

googleCalendarRouter.get('/callback', async (req, res) => {
  const webUrl = getEnv().WEB_URL;
  const result = await completeGoogleCalendarConnection({
    code: typeof req.query.code === 'string' ? req.query.code : '',
    state: typeof req.query.state === 'string' ? req.query.state : '',
  });
  res.redirect(result.ok
    ? `${webUrl}/showings?calendar=connected`
    : `${webUrl}/showings?calendar=error&reason=${encodeURIComponent(result.reason)}`);
});

googleCalendarRouter.delete(
  '/',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      await disconnectCalendar(user.tenantId);
      res.json({ connected: false });
    } catch (err) {
      next(err);
    }
  },
);

googleCalendarRouter.put(
  '/config',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const result = await updateSchedulingConfig(user.tenantId, req.body);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ config: result.config });
    } catch (err) {
      next(err);
    }
  },
);

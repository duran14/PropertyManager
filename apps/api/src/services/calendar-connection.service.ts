/**
 * Conexión de la agencia con Google Calendar: guardar, leer y mantener vivo
 * el access token.
 *
 * El adapter hace HTTP y nada más; aquí vive todo lo que toca la base de
 * datos y el cifrado de credenciales.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CalendarRefreshResult } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { decrypt, encrypt } from '../config/crypto.js';
import { getEnv } from '../config/env.js';
import { writeAudit } from './audit.service.js';

/** Margen antes de considerar vencido un access token. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** Vigencia del `state` del OAuth. */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Llave de unicidad de la conexión. En Postgres dos NULL se consideran
 * distintos entre sí, así que una unique sobre `userId` nulo no impediría dos
 * conexiones de agencia: esta llave sintética sí.
 */
export function tenantOwnerKey(userId?: string | null): string {
  return userId ? `user:${userId}` : 'tenant';
}

export function resolveRedirectUri(): string {
  const env = getEnv();
  return env.GOOGLE_OAUTH_REDIRECT_URI
    || `${env.API_URL}/integrations/google-calendar/callback`;
}

function stateSignature(payload: string): string {
  return createHmac('sha256', getEnv().JWT_ACCESS_SECRET).update(payload).digest('base64url');
}

export function signOAuthState(input: { tenantId: string; userId: string }): string {
  const payload = Buffer.from(JSON.stringify({
    tenantId: input.tenantId,
    userId: input.userId,
    exp: Date.now() + STATE_TTL_MS,
  })).toString('base64url');
  return `${payload}.${stateSignature(payload)}`;
}

export type OAuthStateResult =
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyOAuthState(state: string, now: Date = new Date()): OAuthStateResult {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(stateSignature(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'bad_signature' };
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      tenantId?: unknown; userId?: unknown; exp?: unknown;
    };
    if (typeof decoded.tenantId !== 'string' || typeof decoded.userId !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof decoded.exp !== 'number' || decoded.exp < now.getTime()) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, tenantId: decoded.tenantId, userId: decoded.userId };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

export async function saveCalendarConnection(input: {
  tenantId: string;
  userId?: string | null;
  accountEmail: string;
  showingsCalendarId: string;
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
}): Promise<void> {
  const ownerKey = tenantOwnerKey(input.userId);
  const data = {
    userId: input.userId ?? null,
    accountEmail: input.accountEmail,
    showingsCalendarId: input.showingsCalendarId,
    refreshTokenEnc: encrypt(input.refreshToken),
    accessTokenEnc: encrypt(input.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    status: 'active' as const,
    lastError: null,
    lastErrorAt: null,
  };

  await prisma.calendarConnection.upsert({
    where: { tenantId_ownerKey: { tenantId: input.tenantId, ownerKey } },
    update: data,
    create: { tenantId: input.tenantId, ownerKey, provider: 'google', ...data },
  });

  // Nunca se auditan tokens, solo con qué cuenta quedó conectada.
  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.userId ?? 'system',
    actorType: input.userId ? 'user' : 'system',
    action: 'calendar.connected',
    entityType: 'calendar_connection',
    entityId: ownerKey,
    payload: { accountEmail: input.accountEmail, showingsCalendarId: input.showingsCalendarId },
  });
}

export type UsableAccessToken =
  | {
    ok: true;
    accessToken: string;
    connection: { showingsCalendarId: string; ownerKey: string };
  }
  | { ok: false; reason: 'not_connected' | 'revoked' | 'provider_error' };

export async function getUsableAccessToken(tenantId: string): Promise<UsableAccessToken> {
  const connection = await prisma.calendarConnection.findUnique({
    where: { tenantId_ownerKey: { tenantId, ownerKey: tenantOwnerKey(null) } },
  });
  if (!connection) return { ok: false, reason: 'not_connected' };
  if (connection.status === 'revoked') return { ok: false, reason: 'revoked' };

  const stillValid = connection.accessTokenEnc
    && connection.accessTokenExpiresAt
    && connection.accessTokenExpiresAt.getTime() - Date.now() > TOKEN_EXPIRY_MARGIN_MS;
  if (stillValid) {
    return {
      ok: true,
      accessToken: decrypt(connection.accessTokenEnc!),
      connection: {
        showingsCalendarId: connection.showingsCalendarId,
        ownerKey: connection.ownerKey,
      },
    };
  }

  const { getAdapters } = await import('../config/adapters.js');
  // GoogleCalendarRealAdapter.refreshAccessToken no envuelve su propio fetch
  // en try/catch: una falla de red pura (DNS/timeout/conexión reseteada)
  // rechaza la promesa en vez de resolver a { ok: false, reason: 'provider_error' }.
  // Este es el único call site de refreshAccessToken en el código, así que el
  // try/catch vive aquí para que "errores por valor de retorno" siga siendo
  // cierto para todo el que llame a getUsableAccessToken, no solo el happy path.
  let refreshed: CalendarRefreshResult;
  try {
    refreshed = await getAdapters().calendar.refreshAccessToken({
      refreshToken: decrypt(connection.refreshTokenEnc),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: { lastError: detail, lastErrorAt: new Date() },
    });
    return { ok: false, reason: 'provider_error' };
  }

  if (!refreshed.ok) {
    if (refreshed.reason === 'revoked') {
      await prisma.calendarConnection.update({
        where: { id: connection.id },
        data: { status: 'revoked', lastError: refreshed.detail, lastErrorAt: new Date() },
      });
      return { ok: false, reason: 'revoked' };
    }
    // Transitorio: la conexión se queda encendida a propósito.
    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: { lastError: refreshed.detail, lastErrorAt: new Date() },
    });
    return { ok: false, reason: 'provider_error' };
  }

  await prisma.calendarConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encrypt(refreshed.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
      lastError: null,
      lastErrorAt: null,
    },
  });

  return {
    ok: true,
    accessToken: refreshed.accessToken,
    connection: {
      showingsCalendarId: connection.showingsCalendarId,
      ownerKey: connection.ownerKey,
    },
  };
}

export async function getCalendarConnectionStatus(tenantId: string): Promise<{
  connected: boolean;
  accountEmail?: string;
  status?: 'active' | 'revoked';
  lastError?: string | null;
  lastErrorAt?: Date | null;
}> {
  const connection = await prisma.calendarConnection.findUnique({
    where: { tenantId_ownerKey: { tenantId, ownerKey: tenantOwnerKey(null) } },
  });
  if (!connection) return { connected: false };
  return {
    connected: true,
    accountEmail: connection.accountEmail,
    status: connection.status,
    lastError: connection.lastError,
    lastErrorAt: connection.lastErrorAt,
  };
}

export async function disconnectCalendar(tenantId: string): Promise<void> {
  await prisma.calendarConnection.deleteMany({
    where: { tenantId, ownerKey: tenantOwnerKey(null) },
  });
  await writeAudit({
    tenantId,
    actorId: 'system',
    actorType: 'system',
    action: 'calendar.disconnected',
    entityType: 'calendar_connection',
    entityId: tenantOwnerKey(null),
    payload: {},
  });
}

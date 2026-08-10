import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { decrypt } from '../config/crypto.js';
import {
  disconnectCalendar,
  getCalendarConnectionStatus,
  getUsableAccessToken,
  saveCalendarConnection,
  signOAuthState,
  tenantOwnerKey,
  verifyOAuthState,
} from './calendar-connection.service.js';

const TENANT_ID = 'tenant_test_calendar_connection';

async function cleanup() {
  await prisma.calendarConnection.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Calendar Connection Test', province: 'BC' },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('tenantOwnerKey', () => {
  it('distingue la conexión de agencia de la de un usuario', () => {
    expect(tenantOwnerKey(null)).toBe('tenant');
    expect(tenantOwnerKey('user_1')).toBe('user:user_1');
  });
});

describe('el state firmado del OAuth', () => {
  it('va y vuelve intacto', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const result = verifyOAuthState(state);
    expect(result).toEqual({ ok: true, tenantId: TENANT_ID, userId: 'user_1' });
  });

  it('rechaza un state con la firma alterada', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const tampered = `${state.split('.')[0]}.deadbeef`;
    const result = verifyOAuthState(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rechaza un state con el payload alterado', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const forged = Buffer.from(
      JSON.stringify({ tenantId: 'otro_tenant', userId: 'user_1', exp: Date.now() + 60_000 }),
    ).toString('base64url');
    const result = verifyOAuthState(`${forged}.${state.split('.')[1]}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rechaza un state expirado', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const later = new Date(Date.now() + 11 * 60_000);
    const result = verifyOAuthState(state, later);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rechaza basura', () => {
    expect(verifyOAuthState('no-es-un-state').ok).toBe(false);
  });
});

describe('saveCalendarConnection', () => {
  it('guarda los tokens cifrados, nunca en claro', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_super_secreto',
      accessToken: 'at_super_secreto',
      expiresInSeconds: 3600,
    });

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.refreshTokenEnc).not.toContain('rt_super_secreto');
    expect(decrypt(row.refreshTokenEnc)).toBe('rt_super_secreto');
    expect(decrypt(row.accessTokenEnc!)).toBe('at_super_secreto');
    expect(row.ownerKey).toBe('tenant');
    expect(row.status).toBe('active');
  });

  it('reconectar reemplaza la conexión en vez de crear otra', async () => {
    const input = {
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_1',
      expiresInSeconds: 3600,
    };
    await saveCalendarConnection(input);
    await saveCalendarConnection({ ...input, refreshToken: 'rt_2', accountEmail: 'otro@agencia.com' });

    const rows = await prisma.calendarConnection.findMany({ where: { tenantId: TENANT_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountEmail).toBe('otro@agencia.com');
    expect(decrypt(rows[0]!.refreshTokenEnc)).toBe('rt_2');
  });
});

describe('getUsableAccessToken', () => {
  it('devuelve not_connected cuando no hay conexión', async () => {
    const result = await getUsableAccessToken(TENANT_ID);
    expect(result).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('reutiliza el access token vigente sin llamar a Google', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_vigente',
      expiresInSeconds: 3600,
    });
    const { getAdapters } = await import('../config/adapters.js');
    const spy = vi.spyOn(getAdapters().calendar, 'refreshAccessToken');

    const result = await getUsableAccessToken(TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accessToken).toBe('at_vigente');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refresca cuando el access token está por vencer y guarda el nuevo', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_viejo',
      expiresInSeconds: 10, // dentro del margen de 60 s
    });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'refreshAccessToken').mockResolvedValue({
      ok: true, accessToken: 'at_nuevo', expiresInSeconds: 3600,
    });

    const result = await getUsableAccessToken(TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accessToken).toBe('at_nuevo');

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(decrypt(row.accessTokenEnc!)).toBe('at_nuevo');
  });

  it('apaga la conexión cuando Google dice que el permiso fue revocado', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_viejo',
      expiresInSeconds: 10,
    });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'refreshAccessToken').mockResolvedValue({
      ok: false, reason: 'revoked', detail: 'invalid_grant',
    });

    expect(await getUsableAccessToken(TENANT_ID)).toEqual({ ok: false, reason: 'revoked' });

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.status).toBe('revoked');
    expect(row.lastError).toContain('invalid_grant');
  });

  it('NO apaga la conexión cuando el fallo es transitorio', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_viejo',
      expiresInSeconds: 10,
    });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'refreshAccessToken').mockResolvedValue({
      ok: false, reason: 'provider_error', detail: 'HTTP 500',
    });

    expect(await getUsableAccessToken(TENANT_ID)).toEqual({ ok: false, reason: 'provider_error' });

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.status).toBe('active');
  });

  it('devuelve revoked sin llamar a Google si la conexión ya está apagada', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_1',
      expiresInSeconds: 3600,
    });
    await prisma.calendarConnection.updateMany({
      where: { tenantId: TENANT_ID }, data: { status: 'revoked' },
    });
    const { getAdapters } = await import('../config/adapters.js');
    const spy = vi.spyOn(getAdapters().calendar, 'refreshAccessToken');

    expect(await getUsableAccessToken(TENANT_ID)).toEqual({ ok: false, reason: 'revoked' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('trata un rechazo de red del adapter como provider_error sin apagar la conexión', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_viejo',
      expiresInSeconds: 10,
    });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'refreshAccessToken').mockRejectedValue(new Error('ECONNRESET'));

    expect(await getUsableAccessToken(TENANT_ID)).toEqual({ ok: false, reason: 'provider_error' });

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.status).toBe('active');
    expect(row.lastError).toContain('ECONNRESET');
  });
});

describe('estado y desconexión', () => {
  it('reporta desconectado cuando no hay fila', async () => {
    expect(await getCalendarConnectionStatus(TENANT_ID)).toEqual({ connected: false });
  });

  it('reporta la cuenta conectada y borra al desconectar', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_1',
      expiresInSeconds: 3600,
    });

    const status = await getCalendarConnectionStatus(TENANT_ID);
    expect(status.connected).toBe(true);
    expect(status.accountEmail).toBe('manager@agencia.com');

    await disconnectCalendar(TENANT_ID);
    expect(await getCalendarConnectionStatus(TENANT_ID)).toEqual({ connected: false });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { signOAuthState } from '../services/calendar-connection.service.js';
import { completeGoogleCalendarConnection } from './integrations.google-calendar.js';

const TENANT_ID = 'tenant_test_google_calendar_routes';
const USER_ID = 'user_test_google_calendar_routes';

async function cleanup() {
  await prisma.calendarConnection.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.schedulingConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Google Calendar Routes Test', province: 'BC' },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

describe('completeGoogleCalendarConnection', () => {
  it('rechaza un state manipulado y no guarda nada', async () => {
    const result = await completeGoogleCalendarConnection({ code: 'x', state: 'basura' });
    expect(result).toEqual({ ok: false, reason: 'invalid_state_malformed' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('rechaza un state con firma alterada', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    const tampered = `${state.split('.')[0]}.deadbeef`;
    const result = await completeGoogleCalendarConnection({ code: 'x', state: tampered });
    expect(result).toEqual({ ok: false, reason: 'invalid_state_bad_signature' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('rechaza un state expirado', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    const result = await completeGoogleCalendarConnection({ code: 'x', state });
    expect(result).toEqual({ ok: false, reason: 'invalid_state_expired' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('rechaza cuando falta el código', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    expect(await completeGoogleCalendarConnection({ code: '', state }))
      .toEqual({ ok: false, reason: 'missing_code' });
  });

  it('guarda la conexión con un state válido', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    const result = await completeGoogleCalendarConnection({ code: 'ok', state });

    expect(result).toEqual({ ok: true, accountEmail: 'calendar-mock@example.com' });
    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.accountEmail).toBe('calendar-mock@example.com');
    expect(row.showingsCalendarId).toBe('mock_showings_calendar');
    expect(row.ownerKey).toBe('tenant');
  });

  it('no guarda nada si Google rechaza el canje', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'exchangeAuthorizationCode')
      .mockRejectedValue(new Error('invalid_grant'));

    expect(await completeGoogleCalendarConnection({ code: 'malo', state }))
      .toEqual({ ok: false, reason: 'exchange_failed' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });
});

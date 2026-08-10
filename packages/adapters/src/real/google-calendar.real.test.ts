import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarRealAdapter } from './google-calendar.real.js';

const CONFIG = { clientId: 'client-123', clientSecret: 'secret-456' };

/** id_token de mentiras: solo el payload importa, la firma no se verifica. */
function fakeIdToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('GoogleCalendarRealAdapter', () => {
  it('arma la URL de consentimiento con offline access y los tres scopes', () => {
    const adapter = new GoogleCalendarRealAdapter(CONFIG);
    const url = new URL(adapter.buildAuthorizeUrl({
      redirectUri: 'https://api.example.com/integrations/google-calendar/callback',
      state: 'signed-state',
    }));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.freebusy '
      + 'https://www.googleapis.com/auth/calendar.app.created openid email',
    );
  });

  it('canjea el código y saca el correo del id_token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at_1',
      refresh_token: 'rt_1',
      expires_in: 3599,
      id_token: fakeIdToken('manager@agencia.com'),
    }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.exchangeAuthorizationCode({
      code: 'auth-code',
      redirectUri: 'https://api.example.com/cb',
    });

    expect(result).toEqual({
      accessToken: 'at_1',
      refreshToken: 'rt_1',
      expiresInSeconds: 3599,
      accountEmail: 'manager@agencia.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('refresca el access token', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'at_2', expires_in: 3599 }),
      { status: 200 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    expect(await adapter.refreshAccessToken({ refreshToken: 'rt_1' })).toEqual({
      ok: true, accessToken: 'at_2', expiresInSeconds: 3599,
    });
  });

  it('reporta revoked cuando Google devuelve invalid_grant', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.refreshAccessToken({ refreshToken: 'rt_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('reporta provider_error cuando Google falla con 500', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream boom', { status: 500 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.refreshAccessToken({ refreshToken: 'rt_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('provider_error');
  });

  it('reutiliza el calendario de showings si ya existe', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [
        { id: 'cal_personal', summary: 'Personal' },
        { id: 'cal_showings', summary: 'Property Showings' },
      ],
    }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.ensureShowingsCalendar({
      accessToken: 'at_1', timeZone: 'America/Vancouver',
    });

    expect(result).toEqual({ calendarId: 'cal_showings' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no crea uno nuevo
  });

  it('crea el calendario de showings cuando no existe', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cal_nuevo' }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    expect(await adapter.ensureShowingsCalendar({
      accessToken: 'at_1', timeZone: 'America/Vancouver',
    })).toEqual({ calendarId: 'cal_nuevo' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fusiona los bloques ocupados de todos los calendarios pedidos', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      calendars: {
        primary: { busy: [{ start: '2026-01-14T18:00:00Z', end: '2026-01-14T19:00:00Z' }] },
        cal_showings: { busy: [{ start: '2026-01-14T21:00:00Z', end: '2026-01-14T21:30:00Z' }] },
      },
    }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const busy = await adapter.getBusy({
      accessToken: 'at_1',
      calendarIds: ['primary', 'cal_showings'],
      from: '2026-01-14T00:00:00Z',
      to: '2026-01-15T00:00:00Z',
    });

    expect(busy).toHaveLength(2);
    expect(busy[0]).toEqual({ startAt: '2026-01-14T18:00:00Z', endAt: '2026-01-14T19:00:00Z' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).items).toEqual([{ id: 'primary' }, { id: 'cal_showings' }]);
  });

  it('crea el evento con invitado y pide que Google le avise', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: 'evt_1', htmlLink: 'https://calendar.google.com/evt_1' }),
      { status: 200 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.createEvent({
      accessToken: 'at_1',
      calendarId: 'cal_showings',
      summary: 'Showing — Ana — Pacific Ridge · 101',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
      attendeeEmails: ['ana@example.com'],
    });

    expect(result).toEqual({ eventId: 'evt_1', htmlLink: 'https://calendar.google.com/evt_1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/calendars/cal_showings/events');
    expect(url).toContain('sendUpdates=all');
    expect(JSON.parse(String(init.body)).attendees).toEqual([{ email: 'ana@example.com' }]);
  });

  it('crea el evento sin invitados cuando no hay correo', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'evt_2' }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    await adapter.createEvent({
      accessToken: 'at_1',
      calendarId: 'cal_showings',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('sendUpdates=none');
    expect(JSON.parse(String(init.body)).attendees).toBeUndefined();
  });

  it('trata un 410 al borrar como éxito, porque el evento ya no está', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 410 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    await expect(adapter.deleteEvent({
      accessToken: 'at_1', calendarId: 'cal_showings', eventId: 'evt_1',
    })).resolves.toBeUndefined();
  });

  it('lanza con detalle cuando Google rechaza la creación del evento', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Insufficient permission' } }),
      { status: 403 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    await expect(adapter.createEvent({
      accessToken: 'at_1',
      calendarId: 'cal_showings',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    })).rejects.toThrow(/Insufficient permission/);
  });
});

/**
 * Adapter real de Google Calendar. Solo HTTP: no sabe de la base de datos ni
 * de dónde salieron los tokens.
 *
 * Los scopes son deliberadamente estrechos. `calendar.freebusy` deja ver
 * CUÁNDO está ocupado el manager, nunca DE QUÉ; `calendar.app.created` limita
 * la escritura a los calendarios que esta app creó. Con eso, el token que
 * guardamos no alcanza para leer el detalle de ningún evento personal.
 */
import type {
  CalendarAdapter,
  CalendarBusyInterval,
  CalendarEventInput,
  CalendarRefreshResult,
} from '../contracts.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.app.created',
  'openid email',
].join(' ');

const SHOWINGS_CALENDAR_SUMMARY = 'Property Showings';

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

export class GoogleCalendarRealAdapter implements CalendarAdapter {
  readonly name = 'google_calendar' as const;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GoogleCalendarConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  buildAuthorizeUrl(input: { redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      // Sin estos dos Google no entrega refresh token en reconexiones.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: input.state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
    accountEmail: string;
  }> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Google rechazó el canje del código: ${describeError(body, res.status)}`);
    }
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!refreshToken) {
      // Pasa cuando la cuenta ya autorizó antes y Google no vuelve a mandarlo.
      // Sin refresh token la conexión moriría en una hora, así que es un error.
      throw new Error('Google no devolvió refresh_token; revoca el acceso y vuelve a conectar');
    }
    return {
      refreshToken,
      accessToken: String(body.access_token ?? ''),
      expiresInSeconds: Number(body.expires_in ?? 0),
      accountEmail: emailFromIdToken(body.id_token),
    };
  }

  async refreshAccessToken(input: { refreshToken: string }): Promise<CalendarRefreshResult> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: input.refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (res.ok) {
      const body = (await res.json()) as { access_token: string; expires_in: number };
      return {
        ok: true,
        accessToken: body.access_token,
        expiresInSeconds: Number(body.expires_in ?? 0),
      };
    }
    const raw = await res.text().catch(() => '');
    // invalid_grant es la señal de Google para "ese refresh token ya no sirve":
    // el manager revocó el acceso, o caducó por estar la app en modo Testing.
    const revoked = res.status === 400 && raw.includes('invalid_grant');
    return {
      ok: false,
      reason: revoked ? 'revoked' : 'provider_error',
      detail: raw.slice(0, 500),
    };
  }

  async ensureShowingsCalendar(input: {
    accessToken: string;
    timeZone: string;
  }): Promise<{ calendarId: string }> {
    const listed = await this.request<{ items?: Array<{ id: string; summary?: string }> }>(
      input.accessToken,
      `${CALENDAR_API}/users/me/calendarList`,
      { method: 'GET' },
    );
    const existing = listed.items?.find((item) => item.summary === SHOWINGS_CALENDAR_SUMMARY);
    if (existing) return { calendarId: existing.id };

    const created = await this.request<{ id: string }>(
      input.accessToken,
      `${CALENDAR_API}/calendars`,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: SHOWINGS_CALENDAR_SUMMARY,
          timeZone: input.timeZone,
        }),
      },
    );
    return { calendarId: created.id };
  }

  async getBusy(input: {
    accessToken: string;
    calendarIds: string[];
    from: string;
    to: string;
  }): Promise<CalendarBusyInterval[]> {
    const body = await this.request<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    }>(input.accessToken, `${CALENDAR_API}/freeBusy`, {
      method: 'POST',
      body: JSON.stringify({
        timeMin: input.from,
        timeMax: input.to,
        items: input.calendarIds.map((id) => ({ id })),
      }),
    });

    const intervals: CalendarBusyInterval[] = [];
    for (const calendar of Object.values(body.calendars ?? {})) {
      for (const slot of calendar.busy ?? []) {
        intervals.push({ startAt: slot.start, endAt: slot.end });
      }
    }
    return intervals;
  }

  async createEvent(
    input: { accessToken: string } & CalendarEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }> {
    const attendees = (input.attendeeEmails ?? []).filter((email) => email.length > 0);
    // sendUpdates=all hace que Google mande la invitación y el recordatorio
    // al prospecto; sin invitados no hay a quién avisarle.
    const sendUpdates = attendees.length > 0 ? 'all' : 'none';
    const created = await this.request<{ id: string; htmlLink?: string }>(
      input.accessToken,
      `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}/events`
      + `?sendUpdates=${sendUpdates}`,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: input.summary,
          description: input.description,
          location: input.location,
          start: { dateTime: input.startAt, timeZone: input.timeZone },
          end: { dateTime: input.endAt, timeZone: input.timeZone },
          ...(attendees.length > 0
            ? { attendees: attendees.map((email) => ({ email })) }
            : {}),
        }),
      },
    );
    return { eventId: created.id, htmlLink: created.htmlLink };
  }

  async deleteEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    const res = await this.fetchImpl(
      `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}`
      + `/events/${encodeURIComponent(input.eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${input.accessToken}` },
      },
    );
    // 404/410 significan que el evento ya no está: el objetivo se cumplió.
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw new Error(`Google rechazó el borrado del evento: ${res.status} ${await res.text()}`);
  }

  private async request<T>(accessToken: string, url: string, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Google Calendar respondió ${res.status}: ${describeError(body, res.status)}`);
    }
    return body as T;
  }
}

function describeError(body: Record<string, unknown>, status: number): string {
  const error = body.error;
  if (typeof error === 'string') return `${error} ${String(body.error_description ?? '')}`.trim();
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return `HTTP ${status}`;
}

/**
 * Saca el correo del payload del id_token. No se verifica la firma a
 * propósito: el token llegó directo del endpoint de Google sobre TLS, no de
 * un tercero, así que no hay nada que autenticar.
 */
function emailFromIdToken(idToken: unknown): string {
  if (typeof idToken !== 'string') return '';
  const payload = idToken.split('.')[1];
  if (!payload) return '';
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof decoded.email === 'string' ? decoded.email : '';
  } catch {
    return '';
  }
}

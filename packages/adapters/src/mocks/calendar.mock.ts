/**
 * Mock de calendario para desarrollo y pruebas.
 *
 * Determinista: guarda en memoria los eventos que crea y los reporta como
 * ocupados, así el flujo completo (ofrecer, agendar, no volver a ofrecer ese
 * hueco) se puede ejercitar sin red.
 *
 * OJO: que este mock esté activo NO significa que el bot ofrezca horarios.
 * Sin una CalendarConnection en la base, el servicio pasa a handoff sin
 * importar qué adapter esté seleccionado.
 */
import type {
  CalendarAdapter,
  CalendarBusyInterval,
  CalendarEventInput,
  CalendarRefreshResult,
} from '../contracts.js';

export class CalendarMockAdapter implements CalendarAdapter {
  readonly name = 'calendar_mock' as const;

  private events = new Map<string, { calendarId: string; startAt: string; endAt: string }>();
  private counter = 0;

  /**
   * `getAdapters()` cachea un único set de adapters por proceso, así que este
   * mock sobrevive de una prueba a la siguiente y los eventos de una se
   * reportarían como ocupados en la otra. Las pruebas lo limpian en beforeEach.
   */
  reset(): void {
    this.events.clear();
    this.counter = 0;
  }

  buildAuthorizeUrl(input: { redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
      redirect_uri: input.redirectUri,
      state: input.state,
      mock: 'true',
    });
    return `https://mock.calendar.local/authorize?${params.toString()}`;
  }

  async exchangeAuthorizationCode(): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
    accountEmail: string;
  }> {
    return {
      refreshToken: 'mock_refresh_token',
      accessToken: 'mock_access_token',
      expiresInSeconds: 3600,
      accountEmail: 'calendar-mock@example.com',
    };
  }

  async refreshAccessToken(): Promise<CalendarRefreshResult> {
    return { ok: true, accessToken: 'mock_access_token', expiresInSeconds: 3600 };
  }

  async ensureShowingsCalendar(): Promise<{ calendarId: string }> {
    return { calendarId: 'mock_showings_calendar' };
  }

  async getBusy(input: {
    accessToken: string;
    calendarIds: string[];
    from: string;
    to: string;
  }): Promise<CalendarBusyInterval[]> {
    const fromMs = new Date(input.from).getTime();
    const toMs = new Date(input.to).getTime();
    return [...this.events.values()]
      .filter((event) => input.calendarIds.includes(event.calendarId))
      .filter((event) => new Date(event.endAt).getTime() > fromMs
        && new Date(event.startAt).getTime() < toMs)
      .map((event) => ({ startAt: event.startAt, endAt: event.endAt }));
  }

  async createEvent(
    input: { accessToken: string } & CalendarEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }> {
    const eventId = `mock_event_${++this.counter}`;
    this.events.set(eventId, {
      calendarId: input.calendarId,
      startAt: input.startAt,
      endAt: input.endAt,
    });
    return { eventId, htmlLink: `https://mock.calendar.local/event/${eventId}` };
  }

  async deleteEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    this.events.delete(input.eventId);
  }
}

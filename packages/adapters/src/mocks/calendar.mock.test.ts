import { describe, expect, it } from 'vitest';
import { CalendarMockAdapter } from './calendar.mock.js';

describe('CalendarMockAdapter', () => {
  it('reporta como ocupado un evento que acaba de crear', async () => {
    const adapter = new CalendarMockAdapter();
    const { eventId } = await adapter.createEvent({
      accessToken: 'token',
      calendarId: 'cal_1',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    });

    const busy = await adapter.getBusy({
      accessToken: 'token',
      calendarIds: ['cal_1'],
      from: '2026-01-14T00:00:00.000Z',
      to: '2026-01-15T00:00:00.000Z',
    });
    expect(busy).toEqual([
      { startAt: '2026-01-14T18:00:00.000Z', endAt: '2026-01-14T18:30:00.000Z' },
    ]);

    await adapter.deleteEvent({ accessToken: 'token', calendarId: 'cal_1', eventId });
    const after = await adapter.getBusy({
      accessToken: 'token',
      calendarIds: ['cal_1'],
      from: '2026-01-14T00:00:00.000Z',
      to: '2026-01-15T00:00:00.000Z',
    });
    expect(after).toEqual([]);
  });

  it('ignora eventos de calendarios que no se piden', async () => {
    const adapter = new CalendarMockAdapter();
    await adapter.createEvent({
      accessToken: 'token',
      calendarId: 'otro',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    });
    const busy = await adapter.getBusy({
      accessToken: 'token',
      calendarIds: ['cal_1'],
      from: '2026-01-14T00:00:00.000Z',
      to: '2026-01-15T00:00:00.000Z',
    });
    expect(busy).toEqual([]);
  });
});

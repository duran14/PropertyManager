import { describe, expect, it } from 'vitest';
import { monthBoundsUtc, parseStatementPeriod, zonedDateTimeToUtc } from './period.js';

/** Renderiza una fecha UTC como local time en Vancouver: YYYY-MM-DD HH:mm:ss */
function renderInVancouver(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Vancouver',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '?';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

describe('parseStatementPeriod', () => {
  it('parses a valid YYYY-MM string', () => {
    expect(parseStatementPeriod('2026-08')).toEqual({ year: 2026, month: 8 });
    expect(parseStatementPeriod('2026-01')).toEqual({ year: 2026, month: 1 });
    expect(parseStatementPeriod('2026-12')).toEqual({ year: 2026, month: 12 });
  });

  it.each([
    ['2026-13'],
    ['2026-00'],
    ['2026-8'],
    ['26-08'],
    ['2026/08'],
    ['not-a-period'],
    [''],
  ])('rejects the invalid period %s', (value) => {
    expect(parseStatementPeriod(value)).toBeNull();
  });
});

describe('monthBoundsUtc', () => {
  it('anchors the month to midnight in Vancouver, not UTC', () => {
    // Verifica que periodStart, cuando se renderiza en Vancouver,
    // es exactamente la medianoche del 1 del mes.
    // Esto es inmune a cambios en tzdata y verifica la propiedad real.
    const { periodStart } = monthBoundsUtc(2026, 8);
    expect(renderInVancouver(periodStart)).toBe('2026-08-01 00:00:00');
  });

  it('uses the first instant of the next month as an exclusive end', () => {
    const { periodEnd } = monthBoundsUtc(2026, 8);
    // periodEnd renderizado en Vancouver debe ser medianoche del 1 de septiembre.
    expect(renderInVancouver(periodEnd)).toBe('2026-09-01 00:00:00');
  });

  it('rolls over the year for December', () => {
    const { periodStart, periodEnd } = monthBoundsUtc(2026, 12);
    // Verifica que el inicio de diciembre es el 1 a medianoche
    // y el fin es el 1 de enero del siguiente año a medianoche.
    // Las propiedades importan; los offsets los decide la tzdata.
    expect(renderInVancouver(periodStart)).toBe('2026-12-01 00:00:00');
    expect(renderInVancouver(periodEnd)).toBe('2027-01-01 00:00:00');
  });

  it('handles DST transitions correctly when each boundary falls in different offsets', () => {
    // Octubre 2026 y noviembre 2026 pueden tener diferentes offsets
    // en Vancouver según los datos de tzdata. Lo importante es que
    // cada límite renderizado localmente sea exactamente medianoche
    // del día 1 en su respectivo mes.
    const { periodStart, periodEnd } = monthBoundsUtc(2026, 10);
    expect(renderInVancouver(periodStart)).toBe('2026-10-01 00:00:00');
    expect(renderInVancouver(periodEnd)).toBe('2026-11-01 00:00:00');
  });

  it('produces a start strictly before the end for every month of a year', () => {
    for (let month = 1; month <= 12; month++) {
      const { periodStart, periodEnd } = monthBoundsUtc(2026, month);
      expect(periodStart.getTime()).toBeLessThan(periodEnd.getTime());
    }
  });

  it('anchors boundaries to local midnight, not UTC midnight', () => {
    // Caso histórico con offset conocido e inmutable.
    // Enero 2025 en Vancouver está siempre en UTC-8.
    // Si hubiéramos cometido el error de usar UTC, periodStart sería
    // 2025-01-01T00:00:00Z, que renderizado en Vancouver sería
    // 2025-12-31 16:00:00 (día anterior). Esto verifica que no lo hicimos.
    const { periodStart } = monthBoundsUtc(2025, 1);
    expect(renderInVancouver(periodStart)).toBe('2025-01-01 00:00:00');
  });
});

describe('zonedDateTimeToUtc', () => {
  // Se afirma la PROPIEDAD (cómo se renderiza en esa zona), no una
  // constante UTC: los datos IANA de Vancouver cambian con los años.
  function renderInZone(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  it('devuelve el instante que se ve como esa hora local en enero', () => {
    const utc = zonedDateTimeToUtc(2026, 1, 15, 9, 0, 'America/Vancouver');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('09:00');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('2026-01-15');
  });

  it('devuelve el instante que se ve como esa hora local en julio', () => {
    const utc = zonedDateTimeToUtc(2026, 7, 15, 9, 0, 'America/Vancouver');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('09:00');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('2026-07-15');
  });

  it('funciona igual en una zona con offset positivo', () => {
    const utc = zonedDateTimeToUtc(2026, 3, 20, 14, 30, 'Europe/Madrid');
    expect(renderInZone(utc, 'Europe/Madrid')).toContain('14:30');
  });

  it('monthBoundsUtc sigue dando la medianoche local del día 1', () => {
    const { periodStart } = monthBoundsUtc(2026, 3, 'America/Vancouver');
    expect(renderInZone(periodStart, 'America/Vancouver')).toContain('00:00');
    expect(renderInZone(periodStart, 'America/Vancouver')).toContain('2026-03-01');
  });
});

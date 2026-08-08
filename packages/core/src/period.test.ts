import { describe, expect, it } from 'vitest';
import { monthBoundsUtc, parseStatementPeriod } from './period.js';

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
    // Agosto 2026: Vancouver está en PDT (UTC-7), así que la medianoche
    // local del 1 de agosto son las 07:00 UTC del mismo día.
    const { periodStart } = monthBoundsUtc(2026, 8);
    expect(periodStart.toISOString()).toBe('2026-08-01T07:00:00.000Z');
  });

  it('uses the first instant of the next month as an exclusive end', () => {
    const { periodEnd } = monthBoundsUtc(2026, 8);
    expect(periodEnd.toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('rolls over the year for December', () => {
    const { periodStart, periodEnd } = monthBoundsUtc(2026, 12);
    // Diciembre: Vancouver en PST (UTC-8) → 08:00 UTC.
    expect(periodStart.toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });

  it('handles a month whose start and end fall on different DST offsets', () => {
    // Octubre 2026 empieza en PDT (UTC-7) y noviembre empieza en PST
    // (UTC-8), porque el horario de verano termina el 1 de noviembre a
    // las 2am. Cada límite debe usar SU propio offset, no uno compartido.
    const { periodStart, periodEnd } = monthBoundsUtc(2026, 10);
    expect(periodStart.toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });

  it('produces a start strictly before the end for every month of a year', () => {
    for (let month = 1; month <= 12; month++) {
      const { periodStart, periodEnd } = monthBoundsUtc(2026, month);
      expect(periodStart.getTime()).toBeLessThan(periodEnd.getTime());
    }
  });
});

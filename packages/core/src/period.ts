/**
 * Límites de un mes contable, anclados a la zona del negocio.
 *
 * Importa la zona: un pago del 31 de julio a las 8pm en Vancouver ya es
 * 1 de agosto en UTC. Calcular los límites en UTC lo pondría en el mes
 * equivocado del estado de cuenta.
 *
 * No se agrega ninguna dependencia: `Intl.DateTimeFormat` con `timeZone`
 * viene en Node y resuelve el horario de verano correctamente.
 */

export const BUSINESS_TIME_ZONE = 'America/Vancouver';

const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

/** Parsea "YYYY-MM". Devuelve null si el formato o el mes son inválidos. */
export function parseStatementPeriod(period: string): { year: number; month: number } | null {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Devuelve el intervalo semiabierto [periodStart, periodEnd) del mes dado,
 * como instantes UTC. `periodEnd` es el primer instante del mes SIGUIENTE.
 */
export function monthBoundsUtc(
  year: number,
  month: number,
  timeZone: string = BUSINESS_TIME_ZONE,
): { periodStart: Date; periodEnd: Date } {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    periodStart: zonedMonthStart(year, month, timeZone),
    periodEnd: zonedMonthStart(nextYear, nextMonth, timeZone),
  };
}

/** Instante UTC que corresponde a la medianoche del día 1 en esa zona. */
function zonedMonthStart(year: number, month: number, timeZone: string): Date {
  // Se parte de la medianoche UTC y se corrige por el offset vigente EN
  // ESE instante, así cada límite usa su propio offset de horario de
  // verano en vez de uno compartido para todo el mes.
  const guess = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const offsetMs = timeZoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess + offsetMs);
}

/** Cuántos ms va UTC por delante de la zona en ese instante. */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Intl puede devolver "24" para medianoche en algunas plataformas.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return date.getTime() - asUtc;
}

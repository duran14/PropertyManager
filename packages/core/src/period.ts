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
    periodStart: zonedDateTimeToUtc(year, month, 1, 0, 0, timeZone),
    periodEnd: zonedDateTimeToUtc(nextYear, nextMonth, 1, 0, 0, timeZone),
  };
}

/**
 * Instante UTC que corresponde a esa fecha y hora LOCALES en la zona dada.
 *
 * Se parte del mismo reloj interpretado como UTC y se corrige por el offset
 * vigente EN ESE instante, así cada fecha usa su propio offset de horario de
 * verano en vez de uno compartido para todo el rango.
 *
 * `month` es 1-12.
 */
export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstPassOffsetMs = timeZoneOffsetMs(new Date(guess), timeZone);
  const candidate = guess + firstPassOffsetMs;
  // Segunda pasada: si la hora local pedida cae justo después de un cambio
  // de horario (mismo día calendario que el "spring forward"), el offset
  // vigente en el instante candidato ya no es el mismo que en el instante
  // de la adivinanza inicial. Sin esta corrección, una hora local de las
  // 09:00 podría resolverse como si aún fuera el offset previo a la
  // transición, entregando un instante que en realidad se ve como las
  // 10:00 en la zona.
  const secondPassOffsetMs = timeZoneOffsetMs(new Date(candidate), timeZone);
  return new Date(guess + secondPassOffsetMs);
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

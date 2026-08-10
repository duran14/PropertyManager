/**
 * Motor de huecos disponibles para agendar visitas.
 *
 * Función pura: sin red, sin base de datos y sin reloj implícito — el
 * instante "ahora" entra como parámetro. Lo delicado aquí no es hablar con
 * un calendario, es restar bloques ocupados de un horario laboral
 * respetando los cambios de horario de la zona.
 */
import { z } from 'zod';
import { zonedDateTimeToUtc } from './period.js';

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Los días en el orden que devuelve Date.getUTCDay() sobre la fecha local. */
const WEEKDAY_KEYS: readonly WeekdayKey[] = [
  'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
];

export interface DayRange {
  /** "HH:MM" en 24 h. */
  from: string;
  to: string;
}

export type WeeklyHours = Record<WeekdayKey, DayRange[]>;

export interface TimeRange {
  start: Date;
  end: Date;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

const dayRangeSchema = z
  .object({
    from: z.string().regex(TIME_PATTERN, 'La hora debe ser HH:MM en 24 h'),
    to: z.string().regex(TIME_PATTERN, 'La hora debe ser HH:MM en 24 h'),
  })
  .refine((range) => toMinutes(range.from) < toMinutes(range.to), {
    message: 'El inicio del rango debe ser anterior al fin',
  });

const dayRangesSchema = z
  .array(dayRangeSchema)
  .max(4, 'Máximo 4 rangos por día')
  .refine(
    (ranges) => {
      const sorted = [...ranges].sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
      return sorted.every(
        (range, index) => index === 0 || toMinutes(sorted[index - 1]!.to) <= toMinutes(range.from),
      );
    },
    { message: 'Los rangos de un mismo día no pueden traslaparse' },
  );

export const WeeklyHoursSchema = z.object({
  mon: dayRangesSchema,
  tue: dayRangesSchema,
  wed: dayRangesSchema,
  thu: dayRangesSchema,
  fri: dayRangesSchema,
  sat: dayRangesSchema,
  sun: dayRangesSchema,
});

/**
 * El horario por defecto vive AQUÍ y solo aquí: el servicio lo usa al crear
 * la configuración y la UI para el botón de restaurar. El esquema de Prisma
 * no declara default justamente para que no haya dos definiciones.
 */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ from: '09:00', to: '17:00' }],
  tue: [{ from: '09:00', to: '17:00' }],
  wed: [{ from: '09:00', to: '17:00' }],
  thu: [{ from: '09:00', to: '17:00' }],
  fri: [{ from: '09:00', to: '17:00' }],
  sat: [],
  sun: [],
};

export interface ComputeAvailableSlotsInput {
  /** Primer instante que puede ofrecerse (ya incluye el aviso mínimo). */
  from: Date;
  /** Último instante que puede ofrecerse. */
  to: Date;
  weeklyHours: WeeklyHours;
  /** Bloques ocupados tal como los reporta el proveedor de calendario. */
  busy: TimeRange[];
  timeZone: string;
  durationMinutes: number;
  bufferMinutes: number;
  granularityMinutes: number;
}

export function computeAvailableSlots(input: ComputeAvailableSlotsInput): TimeRange[] {
  const windows = expandWorkingWindows(input);
  const blocked = inflate(merge(input.busy), input.bufferMinutes);

  const durationMs = input.durationMinutes * 60_000;
  const stepMs = input.granularityMinutes * 60_000;
  const slots: TimeRange[] = [];

  for (const window of windows) {
    for (let t = window.start.getTime(); t + durationMs <= window.end.getTime(); t += stepMs) {
      if (t < input.from.getTime()) continue;
      if (t + durationMs > input.to.getTime()) break;
      const candidate = { start: new Date(t), end: new Date(t + durationMs) };
      if (blocked.some((block) => overlaps(candidate, block))) continue;
      slots.push(candidate);
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Convierte el horario semanal en ventanas concretas de UTC, un día local a
 * la vez. Cada límite se calcula con su propio offset, así una ventana que
 * cae después de un cambio de horario no se corre una hora.
 */
function expandWorkingWindows(input: ComputeAvailableSlotsInput): TimeRange[] {
  const windows: TimeRange[] = [];
  // Se empieza un día antes del inicio del rango porque la ventana laboral
  // de ese día puede seguir viva a la hora de `from`.
  const cursor = new Date(input.from.getTime() - 24 * 60 * 60_000);

  while (cursor.getTime() <= input.to.getTime()) {
    const { year, month, day, weekday } = localDateParts(cursor, input.timeZone);
    for (const range of input.weeklyHours[weekday]) {
      const [fromHour, fromMinute] = splitTime(range.from);
      const [toHour, toMinute] = splitTime(range.to);
      windows.push({
        start: zonedDateTimeToUtc(year, month, day, fromHour, fromMinute, input.timeZone),
        end: zonedDateTimeToUtc(year, month, day, toHour, toMinute, input.timeZone),
      });
    }
    cursor.setTime(cursor.getTime() + 24 * 60 * 60_000);
  }

  return windows
    .filter((window) => window.end > input.from && window.start < input.to)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function splitTime(time: string): [number, number] {
  const [hour, minute] = time.split(':');
  return [Number(hour), Number(minute)];
}

function localDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: WeekdayKey } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekdayLabel = get('weekday').toLowerCase().slice(0, 3);
  const weekday = (WEEKDAY_KEYS.find((key) => key === weekdayLabel) ?? 'mon') as WeekdayKey;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday,
  };
}

/** Ordena y fusiona los bloques que se traslapan o se tocan. */
function merge(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start.getTime() <= last.end.getTime()) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: new Date(range.start), end: new Date(range.end) });
    }
  }
  return merged;
}

/**
 * Agrega el colchón de traslado a cada lado. Se infla DESPUÉS de fusionar:
 * si se hiciera antes, dos eventos contiguos generarían un colchón doble en
 * medio, donde en realidad no hay que trasladarse a ningún lado.
 */
function inflate(ranges: TimeRange[], bufferMinutes: number): TimeRange[] {
  if (bufferMinutes <= 0) return ranges;
  const bufferMs = bufferMinutes * 60_000;
  return ranges.map((range) => ({
    start: new Date(range.start.getTime() - bufferMs),
    end: new Date(range.end.getTime() + bufferMs),
  }));
}

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

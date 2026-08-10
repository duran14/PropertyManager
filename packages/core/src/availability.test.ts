import { describe, expect, it } from 'vitest';
import {
  computeAvailableSlots,
  DEFAULT_WEEKLY_HOURS,
  WeeklyHoursSchema,
  type WeeklyHours,
} from './availability.js';
import { zonedDateTimeToUtc } from './period.js';

const TZ = 'America/Vancouver';

/** Cómo se ve ese instante en la zona del negocio, "HH:MM". */
function localTime(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Horario con un solo rango, el mismo todos los días de la semana. */
function everyDay(from: string, to: string): WeeklyHours {
  return {
    mon: [{ from, to }], tue: [{ from, to }], wed: [{ from, to }],
    thu: [{ from, to }], fri: [{ from, to }], sat: [{ from, to }],
    sun: [{ from, to }],
  };
}

const EMPTY: WeeklyHours = {
  mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
};

/** Un miércoles cualquiera, lejos de cualquier cambio de horario. */
const DAY_START = zonedDateTimeToUtc(2026, 1, 14, 0, 0, TZ);
const DAY_END = zonedDateTimeToUtc(2026, 1, 15, 0, 0, TZ);

function base(overrides: Partial<Parameters<typeof computeAvailableSlots>[0]> = {}) {
  return {
    from: DAY_START,
    to: DAY_END,
    weeklyHours: everyDay('09:00', '17:00'),
    busy: [],
    timeZone: TZ,
    durationMinutes: 30,
    bufferMinutes: 0,
    granularityMinutes: 30,
    ...overrides,
  };
}

describe('computeAvailableSlots', () => {
  it('llena la ventana laboral cuando no hay nada ocupado', () => {
    const slots = computeAvailableSlots(base());
    // 09:00 a 17:00 en pasos de 30 min, con visitas de 30 min: 16 huecos.
    expect(slots).toHaveLength(16);
    expect(localTime(slots[0]!.start)).toBe('09:00');
    expect(localTime(slots[slots.length - 1]!.start)).toBe('16:30');
  });

  it('no ofrece nada en un día sin rangos configurados', () => {
    expect(computeAvailableSlots(base({ weeklyHours: EMPTY }))).toHaveLength(0);
  });

  it('no ofrece nada cuando un evento tapa toda la ventana', () => {
    const slots = computeAvailableSlots(base({
      busy: [{
        start: zonedDateTimeToUtc(2026, 1, 14, 8, 0, TZ),
        end: zonedDateTimeToUtc(2026, 1, 14, 18, 0, TZ),
      }],
    }));
    expect(slots).toHaveLength(0);
  });

  it('deja huecos antes y después de un evento parcial', () => {
    const slots = computeAvailableSlots(base({
      busy: [{
        start: zonedDateTimeToUtc(2026, 1, 14, 11, 0, TZ),
        end: zonedDateTimeToUtc(2026, 1, 14, 13, 0, TZ),
      }],
    }));
    const times = slots.map((slot) => localTime(slot.start));
    expect(times).toContain('10:30');
    expect(times).not.toContain('11:00');
    expect(times).not.toContain('12:30');
    expect(times).toContain('13:00');
  });

  it('aplica el colchón a cada lado del evento', () => {
    const slots = computeAvailableSlots(base({
      bufferMinutes: 30,
      busy: [{
        start: zonedDateTimeToUtc(2026, 1, 14, 11, 0, TZ),
        end: zonedDateTimeToUtc(2026, 1, 14, 12, 0, TZ),
      }],
    }));
    const times = slots.map((slot) => localTime(slot.start));
    // 10:30-11:00 quedaría pegado al evento: el colchón lo elimina.
    expect(times).not.toContain('10:30');
    expect(times).toContain('10:00');
    expect(times).not.toContain('12:00');
    expect(times).toContain('12:30');
  });

  it('no duplica el colchón entre dos eventos contiguos', () => {
    const slots = computeAvailableSlots(base({
      bufferMinutes: 30,
      busy: [
        {
          start: zonedDateTimeToUtc(2026, 1, 14, 11, 0, TZ),
          end: zonedDateTimeToUtc(2026, 1, 14, 12, 0, TZ),
        },
        {
          start: zonedDateTimeToUtc(2026, 1, 14, 12, 0, TZ),
          end: zonedDateTimeToUtc(2026, 1, 14, 13, 0, TZ),
        },
      ],
    }));
    const times = slots.map((slot) => localTime(slot.start));
    // Se fusionan a un solo bloque 11:00-13:00 con colchón 10:30-13:30.
    expect(times).toContain('10:00');
    expect(times).not.toContain('10:30');
    expect(times).toContain('13:30');
  });

  it('respeta la hora de comida con dos rangos en el mismo día', () => {
    const lunch: WeeklyHours = {
      ...EMPTY,
      wed: [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '17:00' }],
    };
    const slots = computeAvailableSlots(base({ weeklyHours: lunch }));
    const times = slots.map((slot) => localTime(slot.start));
    expect(times).toContain('11:30');
    expect(times).not.toContain('12:00');
    expect(times).not.toContain('12:30');
    expect(times).toContain('13:00');
  });

  it('no ofrece huecos anteriores a `from`', () => {
    const slots = computeAvailableSlots(base({
      from: zonedDateTimeToUtc(2026, 1, 14, 13, 15, TZ),
    }));
    expect(localTime(slots[0]!.start)).toBe('13:30');
  });

  it('descarta el hueco que no cabe completo antes de cerrar', () => {
    const slots = computeAvailableSlots(base({
      weeklyHours: everyDay('09:00', '10:00'),
      durationMinutes: 45,
    }));
    // Solo 09:00-09:45 cabe; 09:30-10:15 se pasa del cierre.
    expect(slots).toHaveLength(1);
    expect(localTime(slots[0]!.start)).toBe('09:00');
  });

  it('respeta la granularidad de una hora', () => {
    const slots = computeAvailableSlots(base({ granularityMinutes: 60 }));
    const times = slots.map((slot) => localTime(slot.start));
    expect(times).toContain('09:00');
    expect(times).not.toContain('09:30');
    expect(slots).toHaveLength(8);
  });

  it('mantiene la hora local al cruzar un cambio de horario', () => {
    // Rango de una semana que abarca el segundo domingo de marzo, cuando
    // históricamente cambia el horario en Norteamérica. Se afirma que TODOS
    // los primeros huecos del día se ven como 09:00 hora local, sin importar
    // qué haga la zona ese año.
    const slots = computeAvailableSlots(base({
      from: zonedDateTimeToUtc(2026, 3, 6, 0, 0, TZ),
      to: zonedDateTimeToUtc(2026, 3, 13, 0, 0, TZ),
    }));
    const firstOfEachDay = new Map<string, Date>();
    for (const slot of slots) {
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(slot.start);
      if (!firstOfEachDay.has(day)) firstOfEachDay.set(day, slot.start);
    }
    expect(firstOfEachDay.size).toBe(7);
    for (const start of firstOfEachDay.values()) {
      expect(localTime(start)).toBe('09:00');
    }
  });
});

describe('WeeklyHoursSchema', () => {
  it('acepta el horario por defecto', () => {
    expect(WeeklyHoursSchema.safeParse(DEFAULT_WEEKLY_HOURS).success).toBe(true);
  });

  it('rechaza un día faltante', () => {
    const { mon, ...rest } = DEFAULT_WEEKLY_HOURS;
    expect(WeeklyHoursSchema.safeParse(rest).success).toBe(false);
  });

  it('rechaza un rango invertido', () => {
    const bad = { ...EMPTY, mon: [{ from: '17:00', to: '09:00' }] };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it('rechaza rangos traslapados en el mismo día', () => {
    const bad = {
      ...EMPTY,
      mon: [{ from: '09:00', to: '12:00' }, { from: '11:00', to: '15:00' }],
    };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it('rechaza una hora mal formada', () => {
    const bad = { ...EMPTY, mon: [{ from: '9:00', to: '17:00' }] };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it('rechaza más de cuatro rangos en un día', () => {
    const bad = {
      ...EMPTY,
      mon: [
        { from: '08:00', to: '09:00' }, { from: '10:00', to: '11:00' },
        { from: '12:00', to: '13:00' }, { from: '14:00', to: '15:00' },
        { from: '16:00', to: '17:00' },
      ],
    };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });
});

/**
 * Configuración de agenda por tenant: cuándo se puede agendar, con qué
 * duración, colchón y ventana.
 *
 * Google dice cuándo el manager está OCUPADO; esto dice cuándo TRABAJA.
 */
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_WEEKLY_HOURS,
  WeeklyHoursSchema,
  type WeeklyHours,
} from '@property-manager/core';
import { prisma } from '../config/db.js';

export interface SchedulingConfigView {
  weeklyHours: WeeklyHours;
  timeZone: string;
  showingDurationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
}

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const updateSchema = z.object({
  weeklyHours: WeeklyHoursSchema,
  timeZone: z.string().refine(isKnownTimeZone, 'Zona horaria desconocida'),
  showingDurationMinutes: z.union([
    z.literal(15), z.literal(30), z.literal(45), z.literal(60),
  ]),
  bufferMinutes: z.number().int().min(0).max(120),
  minNoticeHours: z.number().int().min(0).max(72),
  maxAdvanceDays: z.number().int().min(1).max(60),
  slotGranularityMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
});

export async function getSchedulingConfig(tenantId: string): Promise<SchedulingConfigView> {
  const row = await prisma.schedulingConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, weeklyHours: DEFAULT_WEEKLY_HOURS as unknown as Prisma.InputJsonValue },
  });

  // Si el JSON guardado no cumple el esquema (edición manual en la base,
  // migración a medias), se cae a los valores por defecto en vez de romper
  // el agendamiento entero.
  const parsed = WeeklyHoursSchema.safeParse(row.weeklyHours);

  return {
    weeklyHours: parsed.success ? parsed.data : DEFAULT_WEEKLY_HOURS,
    timeZone: row.timeZone,
    showingDurationMinutes: row.showingDurationMinutes,
    bufferMinutes: row.bufferMinutes,
    minNoticeHours: row.minNoticeHours,
    maxAdvanceDays: row.maxAdvanceDays,
    slotGranularityMinutes: row.slotGranularityMinutes,
  };
}

export type UpdateSchedulingConfigResult =
  | { ok: true; config: SchedulingConfigView }
  | { ok: false; status: 400; error: string };

export async function updateSchedulingConfig(
  tenantId: string,
  input: unknown,
): Promise<UpdateSchedulingConfigResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    };
  }

  const data = parsed.data;
  await prisma.schedulingConfig.upsert({
    where: { tenantId },
    update: { ...data, weeklyHours: data.weeklyHours as unknown as Prisma.InputJsonValue },
    create: { tenantId, ...data, weeklyHours: data.weeklyHours as unknown as Prisma.InputJsonValue },
  });

  return { ok: true, config: data };
}

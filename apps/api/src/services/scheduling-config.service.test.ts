import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WEEKLY_HOURS } from '@property-manager/core';
import { prisma } from '../config/db.js';
import { getSchedulingConfig, updateSchedulingConfig } from './scheduling-config.service.js';

const TENANT_ID = 'tenant_test_scheduling_config';

async function cleanup() {
  await prisma.schedulingConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Scheduling Config Test', province: 'BC' },
  });
});

afterEach(cleanup);

describe('getSchedulingConfig', () => {
  it('crea la fila con los valores por defecto la primera vez', async () => {
    const config = await getSchedulingConfig(TENANT_ID);
    expect(config.weeklyHours).toEqual(DEFAULT_WEEKLY_HOURS);
    expect(config.timeZone).toBe('America/Vancouver');
    expect(config.showingDurationMinutes).toBe(30);
    expect(config.bufferMinutes).toBe(30);
    expect(config.minNoticeHours).toBe(4);
    expect(config.maxAdvanceDays).toBe(14);
    expect(config.slotGranularityMinutes).toBe(30);

    expect(await prisma.schedulingConfig.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('no duplica la fila al leerla dos veces', async () => {
    await getSchedulingConfig(TENANT_ID);
    await getSchedulingConfig(TENANT_ID);
    expect(await prisma.schedulingConfig.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('vuelve a los valores por defecto si la fila tiene un horario corrupto', async () => {
    await getSchedulingConfig(TENANT_ID);
    await prisma.schedulingConfig.updateMany({
      where: { tenantId: TENANT_ID },
      data: { weeklyHours: { basura: true } },
    });
    const config = await getSchedulingConfig(TENANT_ID);
    expect(config.weeklyHours).toEqual(DEFAULT_WEEKLY_HOURS);
  });
});

describe('updateSchedulingConfig', () => {
  it('guarda un horario válido', async () => {
    const weeklyHours = {
      ...DEFAULT_WEEKLY_HOURS,
      sat: [{ from: '10:00', to: '14:00' }],
    };
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours,
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 45,
      bufferMinutes: 15,
      minNoticeHours: 2,
      maxAdvanceDays: 21,
      slotGranularityMinutes: 15,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.weeklyHours.sat).toEqual([{ from: '10:00', to: '14:00' }]);
      expect(result.config.showingDurationMinutes).toBe(45);
    }
  });

  it('rechaza una duración que no es 15/30/45/60', async () => {
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 37,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    });
    expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  it('rechaza rangos traslapados', async () => {
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours: {
        ...DEFAULT_WEEKLY_HOURS,
        mon: [{ from: '09:00', to: '12:00' }, { from: '11:00', to: '15:00' }],
      },
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 30,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    });
    expect(result.ok).toBe(false);
  });

  it('rechaza una zona horaria que no existe', async () => {
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      timeZone: 'Marte/Olympus',
      showingDurationMinutes: 30,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    });
    expect(result.ok).toBe(false);
  });

  it('rechaza valores fuera de rango', async () => {
    const base = {
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 30,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    };
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, bufferMinutes: 121 })).ok).toBe(false);
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, minNoticeHours: 73 })).ok).toBe(false);
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, maxAdvanceDays: 0 })).ok).toBe(false);
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, slotGranularityMinutes: 45 })).ok).toBe(false);
  });
});

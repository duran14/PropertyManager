import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedDateTimeToUtc } from '@property-manager/core';
import { prisma } from '../config/db.js';
import { disconnectCalendar, saveCalendarConnection } from './calendar-connection.service.js';
import {
  bookShowingFromCalendar,
  cancelShowing,
  createManualShowingFromConversation,
  getSchedulingAvailability,
} from './scheduling.service.js';

const TENANT_ID = 'tenant_test_scheduling_calendar';

async function cleanup() {
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.conversationEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  // Antes de leads/units: ChatConversation los referencia y no tiene cascade
  // en esas FKs, así que borrarlos primero rompería la limpieza.
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.calendarConnection.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.schedulingConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed() {
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Scheduling Calendar Test', province: 'BC' },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: TENANT_ID,
      email: `pm-${TENANT_ID}@example.com`,
      passwordHash: 'x',
      firstName: 'Pat',
      lastName: 'Manager',
      role: 'property_manager',
    },
  });
  const property = await prisma.property.create({
    data: {
      tenantId: TENANT_ID,
      name: 'Pacific Ridge',
      address: '100 Test St',
      city: 'Vancouver',
      province: 'BC',
    },
  });
  const unit = await prisma.unit.create({
    data: {
      tenantId: TENANT_ID,
      propertyId: property.id,
      name: 'Unit 101',
      rentCents: 200_000,
      slug: `unit-101-${TENANT_ID}`,
    },
  });
  // Lead.source no tiene default en el schema — el brief original lo omitía;
  // sin él Prisma rechaza el create.
  const lead = await prisma.lead.create({
    data: {
      tenantId: TENANT_ID, name: 'Ana Prospect', phone: '+16045550111', status: 'contacted',
      source: 'web',
    },
  });
  const secondLead = await prisma.lead.create({
    data: {
      tenantId: TENANT_ID, name: 'Beto Prospect', phone: '+16045550222', status: 'contacted',
      source: 'web',
    },
  });
  return {
    unitId: unit.id,
    leadId: lead.id,
    secondLeadId: secondLead.id,
    userId: user.id,
  };
}

/** Conecta el calendario por el servicio real, no escribiendo la fila a mano. */
async function connectCalendar() {
  await saveCalendarConnection({
    tenantId: TENANT_ID,
    accountEmail: 'manager@agencia.com',
    showingsCalendarId: 'mock_showings_calendar',
    refreshToken: 'rt_test',
    accessToken: 'at_test',
    expiresInSeconds: 3600,
  });
}

beforeEach(async () => {
  await cleanup();
  // getAdapters() cachea un único set por proceso: sin esto, los eventos que
  // cree una prueba se reportan como ocupados en la siguiente.
  const { getAdapters } = await import('../config/adapters.js');
  const calendar = getAdapters().calendar as { reset?: () => void };
  calendar.reset?.();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('getSchedulingAvailability', () => {
  it('devuelve not_connected cuando la agencia no conectó su calendario', async () => {
    const { unitId } = await seed();
    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'not_connected',
    });
  });

  it('devuelve revoked cuando el permiso fue retirado', async () => {
    const { unitId } = await seed();
    await connectCalendar();
    await prisma.calendarConnection.updateMany({
      where: { tenantId: TENANT_ID }, data: { status: 'revoked' },
    });
    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'revoked',
    });
  });

  it('devuelve provider_error cuando Google falla al pedir disponibilidad', async () => {
    const { unitId } = await seed();
    await connectCalendar();
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'getBusy').mockRejectedValue(new Error('boom'));

    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'provider_error',
    });
  });

  it('ofrece a lo más 6 huecos, etiquetados en la zona configurada', async () => {
    const { unitId } = await seed();
    await connectCalendar();

    const result = await getSchedulingAvailability(TENANT_ID, unitId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots.length).toBeGreaterThan(0);
      expect(result.slots.length).toBeLessThanOrEqual(6);
      expect(result.slots[0]!.index).toBe(0);
      expect(result.slots[0]!.label).toMatch(/\d/);
    }
  });

  it('devuelve no_slots cuando el horario laboral está vacío', async () => {
    const { unitId } = await seed();
    await connectCalendar();
    await prisma.schedulingConfig.upsert({
      where: { tenantId: TENANT_ID },
      update: { weeklyHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } },
      create: {
        tenantId: TENANT_ID,
        weeklyHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      },
    });

    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'no_slots',
    });
  });
});

describe('bookShowingFromCalendar', () => {
  it('crea el showing y el evento de Google', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');

    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId,
      startAt: new Date(available.slots[0]!.startAt),
      prospectName: 'Ana Prospect',
      prospectEmail: 'ana@example.com',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const showing = await prisma.showing.findUniqueOrThrow({ where: { id: result.showingId } });
    expect(showing.googleEventId).toBe(result.googleEventId);
    expect(showing.calendarSlotKey).toContain('tenant:');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status)
      .toBe('tour_scheduled');
  });

  it('rechaza un horario que ya no se está ofreciendo', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();

    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId,
      // Un domingo a las 3 de la mañana: nunca está en el horario laboral.
      startAt: zonedDateTimeToUtc(2026, 1, 11, 3, 0, 'America/Vancouver'),
      prospectName: 'Ana Prospect',
    });

    expect(result).toEqual({ ok: false, status: 409, error: 'slot_no_longer_offered' });
  });

  it('con dos reservas simultáneas del mismo horario, crea exactamente un showing', async () => {
    const { unitId, leadId, secondLeadId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const startAt = new Date(available.slots[0]!.startAt);

    const [first, second] = await Promise.all([
      bookShowingFromCalendar({
        tenantId: TENANT_ID, unitId, leadId, startAt, prospectName: 'Ana',
      }),
      bookShowingFromCalendar({
        tenantId: TENANT_ID, unitId, leadId: secondLeadId, startAt, prospectName: 'Beto',
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    // Cuál de los dos 409 sale depende de si el segundo alcanzó a leer la
    // disponibilidad antes o después de que el primero creara su evento. Lo
    // que NO depende de la carrera, y es lo que importa, es que solo quede un
    // showing: esa garantía la da la unique de base, no el orden.
    const rejected = outcomes.find((outcome) => !outcome.ok);
    expect(rejected && !rejected.ok && rejected.error)
      .toMatch(/^(slot_taken|slot_no_longer_offered)$/);
    expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('no deja ningún showing si Google rechaza el evento, y revierte al lead a su estado previo', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const leadBefore = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'createEvent').mockRejectedValue(new Error('403'));

    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId,
      startAt: new Date(available.slots[0]!.startAt),
      prospectName: 'Ana Prospect',
    });

    expect(result).toEqual({ ok: false, status: 503, error: 'calendar_unavailable' });
    expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(0);
    // La transacción original ya había marcado al lead tour_scheduled y le
    // había puesto unitId antes de que el evento de Google fallara — la
    // compensación tiene que deshacer eso también, no solo borrar el Showing.
    const leadAfter = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(leadAfter.status).toBe(leadBefore.status);
    expect(leadAfter.unitId).toBe(leadBefore.unitId);
  });

  it('el hueco reservado deja de ofrecerse', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();
    const before = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!before.ok) throw new Error('se esperaban huecos');
    const startAt = before.slots[0]!.startAt;

    await bookShowingFromCalendar({
      tenantId: TENANT_ID, unitId, leadId, startAt: new Date(startAt), prospectName: 'Ana',
    });

    const after = await getSchedulingAvailability(TENANT_ID, unitId);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.slots.map((slot) => slot.startAt)).not.toContain(startAt);
  });
});

describe('cancelShowing', () => {
  it('borra el evento de Google y libera el hueco', async () => {
    const { unitId, leadId, userId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const booked = await bookShowingFromCalendar({
      tenantId: TENANT_ID, unitId, leadId,
      startAt: new Date(available.slots[0]!.startAt), prospectName: 'Ana',
    });
    if (!booked.ok) throw new Error('la reserva debió funcionar');

    const { getAdapters } = await import('../config/adapters.js');
    const deleteSpy = vi.spyOn(getAdapters().calendar, 'deleteEvent');

    await cancelShowing(booked.showingId, TENANT_ID, userId, 'el prospecto canceló');

    expect(deleteSpy).toHaveBeenCalled();
    const showing = await prisma.showing.findUniqueOrThrow({ where: { id: booked.showingId } });
    expect(showing.status).toBe('cancelled');
    expect(showing.calendarSlotKey).toBeNull();
  });
});

describe('createManualShowingFromConversation', () => {
  it('deja calendarSlotKey listo para bloquear un bookShowingFromCalendar posterior al mismo horario', async () => {
    const { unitId, leadId, secondLeadId, userId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const startAt = new Date(available.slots[0]!.startAt);

    // El calendario se desconecta ANTES de la reserva manual a propósito: así
    // createManualShowingFromConversation no llega a crear el evento de
    // Google (rama de mejor esfuerzo, se salta) y el único rastro de que ese
    // horario ya está tomado es el calendarSlotKey en la base — exactamente
    // el escenario del Finding 2, donde getBusy nunca se entera del showing
    // manual.
    await disconnectCalendar(TENANT_ID);

    const conversation = await prisma.chatConversation.create({
      data: {
        tenantId: TENANT_ID,
        externalId: `manual-${TENANT_ID}`,
        channel: 'web',
        leadId,
        unitId,
      },
    });

    const manual = await createManualShowingFromConversation({
      tenantId: TENANT_ID,
      conversationId: conversation.id,
      scheduledAt: startAt,
      actorId: userId,
    });
    expect(manual.calendarSlotKey).toContain('tenant:');
    expect(manual.googleEventId).toBeNull();

    // Se reconecta para la segunda reserva: getSchedulingAvailability sigue
    // ofreciendo ese horario (Google nunca se enteró del showing manual), así
    // que lo único que puede rechazar la segunda reserva es la unique de
    // calendarSlotKey — la red de concurrencia de base, no la de Google.
    await connectCalendar();

    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId: secondLeadId,
      startAt,
      prospectName: 'Beto',
    });

    expect(result).toEqual({ ok: false, status: 409, error: 'slot_taken' });
    expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });
});

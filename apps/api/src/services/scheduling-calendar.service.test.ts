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
  // Ninguna prueba de este archivo debería dejar el reloj congelado para la
  // siguiente — restoreAllMocks no cubre useFakeTimers/setSystemTime.
  vi.useRealTimers();
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

describe('bookShowingFromCalendar — drift entre el GET de horarios y el POST de reserva (Finding 1)', () => {
  it('rechaza un startAt que se cayó de la ventana de min-notice tras avanzar el reloj, en vez de reservar otro hueco', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();

    // Reloj fijo y horario laboral cómodo (lejos de medianoche) para que el
    // resultado no dependa de a qué hora real corre la prueba: 2026-01-05 es
    // lunes, 10:00 America/Vancouver (UTC-8 en enero, sin DST) = 18:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T18:00:00.000Z'));

    // Aviso mínimo y granularidad chicos para poder empujar el primer hueco
    // fuera de la ventana con un salto de reloj pequeño y determinista.
    await prisma.schedulingConfig.upsert({
      where: { tenantId: TENANT_ID },
      update: { minNoticeHours: 1, slotGranularityMinutes: 15, showingDurationMinutes: 15, bufferMinutes: 0 },
      create: {
        tenantId: TENANT_ID,
        weeklyHours: { mon: [{ from: '09:00', to: '17:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
        minNoticeHours: 1,
        slotGranularityMinutes: 15,
        showingDurationMinutes: 15,
        bufferMinutes: 0,
      },
    });

    // Esto simula el GET .../slots que el prospecto ve: captura el startAt
    // exacto del primer hueco (11:00 Vancouver: 10:00 + 1h de aviso).
    const seen = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!seen.ok) throw new Error('se esperaban huecos');
    const staleStartAt = seen.slots[0]!.startAt;

    // El prospecto tarda en llenar el formulario: el reloj avanza más que la
    // granularidad. El "ahora" que ve el servidor en el POST ya no es el
    // mismo que cuando se ofrecieron los horarios.
    vi.setSystemTime(new Date('2026-01-05T18:20:00.000Z'));

    const driftedAvailability = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!driftedAvailability.ok) throw new Error('se esperaban huecos tras el drift');
    // Confirma que el drift realmente movió la lista — si no, la prueba no
    // estaría probando nada.
    expect(driftedAvailability.slots.map((slot) => slot.startAt)).not.toContain(staleStartAt);

    // El bug del Finding 1 era que la RUTA reindexaba `slots[booking.slotIndex]`
    // contra esta disponibilidad ya corrida, reservando silenciosamente el
    // hueco que ahora ocupa ese índice — no el que el prospecto vio. Con el
    // fix, la ruta ya no reindexa: pasa el startAt tal cual, y
    // bookShowingFromCalendar debe rechazarlo porque ya no está en la lista
    // fresca, en vez de reservar el hueco que quedó en su lugar.
    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId,
      startAt: new Date(staleStartAt),
      prospectName: 'Ana Prospect',
    });

    expect(result).toEqual({ ok: false, status: 409, error: 'slot_no_longer_offered' });
    expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(0);
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

  it('dos reservas manuales al mismo instante crean exactamente un showing; la segunda falla con un resultado discriminado, no una excepción sin marcar (Finding 2)', async () => {
    const { unitId, leadId, secondLeadId, userId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const startAt = new Date(available.slots[0]!.startAt);

    const conversationA = await prisma.chatConversation.create({
      data: { tenantId: TENANT_ID, externalId: `manual-a-${TENANT_ID}`, channel: 'web', leadId, unitId },
    });
    const conversationB = await prisma.chatConversation.create({
      data: { tenantId: TENANT_ID, externalId: `manual-b-${TENANT_ID}`, channel: 'web', leadId: secondLeadId, unitId },
    });

    const first = await createManualShowingFromConversation({
      tenantId: TENANT_ID, conversationId: conversationA.id, scheduledAt: startAt, actorId: userId,
    });
    expect(first.calendarSlotKey).toContain('tenant:');

    // `calendarSlotKey` es único por tenant, no por lead: un segundo PM (o el
    // mismo) agendando a mano el MISMO instante para OTRO lead choca esa
    // unique. Antes del fix esto lanzaba un P2002 sin marcar que el error
    // handler global convertía en un 500 opaco — el PM veía que no pasaba
    // nada al hacer clic.
    await expect(createManualShowingFromConversation({
      tenantId: TENANT_ID, conversationId: conversationB.id, scheduledAt: startAt, actorId: userId,
    })).rejects.toThrow('slot_taken');

    expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });
});

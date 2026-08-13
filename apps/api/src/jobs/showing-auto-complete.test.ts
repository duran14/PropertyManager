import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import * as rentalApplicationService from '../services/rental-application.service.js';
import { findShowingsDueForAutoComplete, runShowingAutoCompleteSweep } from './showing-auto-complete.js';

vi.mock('../services/rental-application.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/rental-application.service.js')>();
  return { ...actual, completeShowingAndInvite: vi.fn(actual.completeShowingAndInvite) };
});

const TENANT_ID = 'tenant_test_showing_auto_complete';
const TWO_HOURS_MS = 2 * 60 * 60_000;

async function seedShowing(overrides: {
  scheduledAt: Date;
  durationMinutes?: number;
  status?: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  brokerUserId?: string | null;
}) {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Showing Auto-Complete Test Tenant', province: 'BC' },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, phone: `+1604555${Math.floor(Math.random() * 9000 + 1000)}`, source: 'web', status: 'new_' },
  });
  const showing = await prisma.showing.create({
    data: {
      tenantId: TENANT_ID,
      leadId: lead.id,
      scheduledAt: overrides.scheduledAt,
      durationMinutes: overrides.durationMinutes ?? 30,
      status: overrides.status ?? 'confirmed',
      brokerUserId: overrides.brokerUserId ?? null,
    },
  });
  return { lead, showing };
}

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('findShowingsDueForAutoComplete', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('incluye un showing cuyo fin + 2h ya pasó', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    // scheduledAt + 30min + 2h = 12:30 + 2h = 14:30, antes de las 15:00 -> vencido.
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z') });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).toContain(showing.id);
  });

  it('excluye un showing cuyo fin + 2h todavía no llega', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    // scheduledAt + 30min + 2h = 14:30 + 2h = 17:00, después de las 15:00 -> no vencido.
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T14:00:00Z') });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });

  it('excluye un showing ya completado', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z'), status: 'completed' });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });

  it('excluye un showing cancelado', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z'), status: 'cancelled' });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });

  it('excluye un showing tan viejo que su vencimiento cayó hace más de 48h (protección anti-blast retroactivo)', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    // Vencimiento: hace 49 horas.
    const staleScheduledAt = new Date(now.getTime() - 49 * 60 * 60_000 - TWO_HOURS_MS - 30 * 60_000);
    const { showing } = await seedShowing({ scheduledAt: staleScheduledAt });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });
});

describe('runShowingAutoCompleteSweep', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('completa los showings vencidos y cuenta el resultado', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z') });
    await seedShowing({ scheduledAt: new Date('2026-08-13T11:00:00Z') });
    const send = vi.fn().mockResolvedValue({ messageId: 'x' });
    const messaging = new Proxy({}, { get: () => ({ send }) }) as any;

    const result = await runShowingAutoCompleteSweep({ messaging, now });

    expect(result).toEqual({ completed: 2, skipped: 0 });
    const rows = await prisma.showing.findMany({ where: { tenantId: TENANT_ID } });
    expect(rows.every((s) => s.status === 'completed')).toBe(true);
  });

  it('cuenta como skipped cuando completeShowingAndInvite devuelve un 409 (carrera con el botón manual u otro ciclo del sondeo)', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z') });
    vi.mocked(rentalApplicationService.completeShowingAndInvite).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'Showing cannot be completed from status: completed',
    });
    const send = vi.fn().mockResolvedValue({ messageId: 'x' });
    const messaging = new Proxy({}, { get: () => ({ send }) }) as any;

    const result = await runShowingAutoCompleteSweep({ messaging, now });

    expect(result).toEqual({ completed: 0, skipped: 1 });
  });
});

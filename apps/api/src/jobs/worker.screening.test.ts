/**
 * Finding 1 del review de Tarea 4: si BullMQ agota los reintentos de
 * `screeningPollQueue` sin que el proveedor haya resuelto, el checkeo no
 * puede quedar 'pending' para siempre. `handleScreeningPollFailure` es la
 * lógica pura detrás del listener 'failed' del worker real — probada aquí
 * con un job-like de mentiras, sin levantar un Worker de BullMQ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { handleScreeningPollFailure } from './worker.js';
import { runScreeningRequest } from '../services/screening.service.js';

const TENANT_ID = 'tenant_test_worker_screening_poll';

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed() {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Worker Screening Test', province: 'BC' } });
  await prisma.user.create({
    data: {
      tenantId: TENANT_ID, email: `pm-${TENANT_ID}@example.com`, passwordHash: 'x',
      firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
    },
  });
  const property = await prisma.property.create({
    data: { tenantId: TENANT_ID, name: 'Pacific Ridge', address: '200 Test St', city: 'Vancouver', province: 'BC' },
  });
  const unit = await prisma.unit.create({
    data: { tenantId: TENANT_ID, propertyId: property.id, name: 'Unit 201', rentCents: 200_000, slug: `unit-201-${TENANT_ID}` },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, name: 'Bea', phone: '+16045550112', status: 'contacted', source: 'manual' },
  });
  const showing = await prisma.showing.create({
    data: { tenantId: TENANT_ID, leadId: lead.id, unitId: unit.id, scheduledAt: new Date(), status: 'completed' },
  });
  const application = await prisma.rentalApplication.create({
    data: {
      tenantId: TENANT_ID, showingId: showing.id, leadId: lead.id, unitId: unit.id,
      tokenHash: `hash_${TENANT_ID}`, expiresAt: new Date(Date.now() + 86_400_000),
      status: 'submitted', applicantFullName: 'Bea Prospect',
      dateOfBirth: new Date('1990-05-15'), currentAddress: '123 Test St',
      currentCity: 'Vancouver', currentProvince: 'British Columbia', currentPostalCode: 'V6B 1A1',
      consentApplicationAt: new Date(), consentCreditCheckAt: new Date(), consentPoliceCheckAt: new Date(),
    },
  });
  return { applicationId: application.id };
}

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('handleScreeningPollFailure', () => {
  it('cierra el checkeo como failed cuando el job agotó todos sus reintentos', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    await handleScreeningPollFailure(
      {
        id: 'fake-job-exhausted',
        data: { tenantId: TENANT_ID, applicationId, kind: 'credit', providerRef: 'irrelevant' },
        attemptsMade: 10,
        opts: { attempts: 10 },
      },
      new Error('Screening result still pending'),
    );

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('failed');
    expect(row.creditCheckSummary).toMatch(/did not arrive/i);
  });

  it('no toca el estado mientras todavía queden reintentos', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    await handleScreeningPollFailure(
      {
        id: 'fake-job-midway',
        data: { tenantId: TENANT_ID, applicationId, kind: 'credit', providerRef: 'irrelevant' },
        attemptsMade: 3,
        opts: { attempts: 10 },
      },
      new Error('Screening result still pending'),
    );

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
  });

  it('no revienta si BullMQ dispara "failed" sin un job asociado', async () => {
    await expect(handleScreeningPollFailure(undefined, new Error('boom'))).resolves.toBeUndefined();
  });
});

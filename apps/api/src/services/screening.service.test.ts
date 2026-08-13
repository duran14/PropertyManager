import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { pollScreeningResult, runScreeningRequest, triggerScreeningIfConsented } from './screening.service.js';

const TENANT_ID = 'tenant_test_screening_service';

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed(overrides: { consented?: boolean; fullName?: string } = {}) {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Screening Service Test', province: 'BC' } });
  await prisma.user.create({
    data: {
      tenantId: TENANT_ID, email: `pm-${TENANT_ID}@example.com`, passwordHash: 'x',
      firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
    },
  });
  const property = await prisma.property.create({
    data: { tenantId: TENANT_ID, name: 'Pacific Ridge', address: '100 Test St', city: 'Vancouver', province: 'BC' },
  });
  const unit = await prisma.unit.create({
    data: { tenantId: TENANT_ID, propertyId: property.id, name: 'Unit 101', rentCents: 200_000, slug: `unit-101-${TENANT_ID}` },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, name: 'Ana', phone: '+16045550111', status: 'contacted', source: 'manual' },
  });
  const showing = await prisma.showing.create({
    data: { tenantId: TENANT_ID, leadId: lead.id, unitId: unit.id, scheduledAt: new Date(), status: 'completed' },
  });
  const consentedAt = overrides.consented === false ? null : new Date();
  const application = await prisma.rentalApplication.create({
    data: {
      tenantId: TENANT_ID, showingId: showing.id, leadId: lead.id, unitId: unit.id,
      tokenHash: `hash_${TENANT_ID}`, expiresAt: new Date(Date.now() + 86_400_000),
      status: 'submitted', applicantFullName: overrides.fullName ?? 'Ana Prospect',
      dateOfBirth: new Date('1990-05-15'), currentAddress: '123 Test St',
      currentCity: 'Vancouver', currentProvince: 'British Columbia', currentPostalCode: 'V6B 1A1',
      consentApplicationAt: consentedAt, consentCreditCheckAt: consentedAt, consentPoliceCheckAt: consentedAt,
    },
  });
  return { applicationId: application.id };
}

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('triggerScreeningIfConsented', () => {
  it('marca ambos checkeos como requested cuando hay consentimiento', async () => {
    const { applicationId } = await seed();
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('requested');
    expect(row.criminalCheckStatus).toBe('requested');
    expect(row.creditCheckRequestedAt).not.toBeNull();
  });

  it('no dispara nada sin consentimiento', async () => {
    const { applicationId } = await seed({ consented: false });
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBeNull();
    expect(row.criminalCheckStatus).toBeNull();
  });
});

describe('runScreeningRequest', () => {
  it('persiste pending y la referencia del proveedor', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
    expect(row.creditCheckProviderRef).toMatch(/^mock_credit_/);
  });
});

describe('pollScreeningResult', () => {
  it('al completarse guarda el reporte, el resumen, y notifica al staff', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'criminal');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'criminal', midway.criminalCheckProviderRef!);

    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.criminalCheckStatus).toBe('passed');
    expect(row.criminalCheckSummary).toContain('No criminal record');
    expect(row.criminalCheckReportKey).not.toBeNull();
    expect(row.criminalCheckCompletedAt).not.toBeNull();
  });

  it('un solicitante marcado "Flagged" produce el veredicto flagged', async () => {
    const { applicationId } = await seed({ fullName: 'Flagged Applicant' });
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('flagged');
  });

  it('devuelve done:false mientras sigue pending', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().screening, 'pollResult').mockResolvedValue({
      status: 'pending', providerRef: midway.creditCheckProviderRef!,
    });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);
    expect(done).toBe(false);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
  });

  it('un fallo del adapter marca failed y avisa al staff, sin lanzar', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().screening, 'pollResult').mockResolvedValue({
      status: 'failed', reason: 'Portal login failed',
    });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);
    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('failed');
    expect(row.creditCheckSummary).toContain('Portal login failed');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { previewOwnerStatement } from './owner-statement.service.js';

const TENANT_ID = 'tenant_test_owner_statement';

async function cleanup() {
  await prisma.ownerStatement.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.bill.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.transaction.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { property: { tenantId: TENANT_ID } } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.owner.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed(options: {
  withOwner?: boolean;
  feeBps?: number;
  reserveTargetCents?: number;
} = {}) {
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Owner Statement Test', province: 'BC' },
  });
  const owner = options.withOwner === false
    ? null
    : await prisma.owner.create({
      data: { tenantId: TENANT_ID, firstName: 'Olivia', lastName: 'Owner' },
    });
  const property = await prisma.property.create({
    data: {
      tenantId: TENANT_ID,
      name: 'Pacific Ridge',
      address: '100 Test St',
      city: 'Vancouver',
      province: 'BC',
      ownerId: owner?.id ?? null,
      managementFeePercentBps: options.feeBps ?? 1250,
      reserveFundTargetCents: options.reserveTargetCents ?? 0,
    },
  });
  const unit = await prisma.unit.create({
    data: {
      tenantId: TENANT_ID,
      propertyId: property.id,
      name: 'Unit 101',
      rentCents: 200_000,
      slug: `unit-101-${Date.now()}`,
    },
  });
  return { owner, property, unit };
}

async function addRent(unitId: string, amountCents: number, occurredAt: Date, reference: string) {
  await prisma.transaction.create({
    data: {
      tenantId: TENANT_ID,
      type: 'rent_payment',
      source: 'bank',
      amountCents,
      reference,
      unitId,
      occurredAt,
    },
  });
}

async function addBill(options: {
  totalCents: number;
  billDate: Date;
  status?: 'approved' | 'synced_to_qbo' | 'pending_review';
  unitId?: string;
  propertyId?: string;
}) {
  await prisma.bill.create({
    data: {
      tenantId: TENANT_ID,
      vendorName: 'Acme',
      billDate: options.billDate,
      totalCents: options.totalCents,
      category: 'repairs',
      status: options.status ?? 'approved',
      unitId: options.unitId,
      propertyId: options.propertyId,
    },
  });
}

describe('previewOwnerStatement', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('sums rent income and expenses for the period and applies the fee', async () => {
    const { property, unit } = await seed();
    await addRent(unit.id, 200_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    await addBill({ totalCents: 30_000, billDate: new Date('2026-08-15T12:00:00Z'), unitId: unit.id });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID,
      propertyId: property.id,
      period: '2026-08',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.preview.rentIncomeCents).toBe(200_000);
    expect(result.preview.expensesCents).toBe(30_000);
    expect(result.preview.managementFeeCents).toBe(25_000);
    expect(result.preview.ownerPayoutCents).toBe(145_000);
    expect(result.preview.alreadyClosed).toBe(false);
  });

  it('includes property-level bills that have no unit', async () => {
    const { property } = await seed();
    await addBill({ totalCents: 40_000, billDate: new Date('2026-08-05T12:00:00Z'), propertyId: property.id });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.expensesCents).toBe(40_000);
  });

  it('excludes bills that are not approved yet', async () => {
    const { property, unit } = await seed();
    await addBill({
      totalCents: 99_000,
      billDate: new Date('2026-08-05T12:00:00Z'),
      unitId: unit.id,
      status: 'pending_review',
    });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.expensesCents).toBe(0);
  });

  it('excludes movements from other months', async () => {
    const { property, unit } = await seed();
    await addRent(unit.id, 200_000, new Date('2026-07-10T12:00:00Z'), 'rent-jul');
    await addRent(unit.id, 111_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    await addBill({ totalCents: 50_000, billDate: new Date('2026-09-02T12:00:00Z'), unitId: unit.id });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.rentIncomeCents).toBe(111_000);
    expect(result.preview.expensesCents).toBe(0);
  });

  it('counts a payment made late on the last day of the month in Vancouver', async () => {
    const { property, unit } = await seed();
    // 31 de agosto 20:00 en Vancouver = 1 de septiembre 03:00 UTC.
    // Debe contar en AGOSTO, no en septiembre.
    await addRent(unit.id, 77_000, new Date('2026-09-01T03:00:00Z'), 'rent-late-aug');

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.rentIncomeCents).toBe(77_000);
  });

  it('subtracts the reserve already withheld in prior closed statements', async () => {
    const { property, owner, unit } = await seed({ reserveTargetCents: 50_000 });
    await addRent(unit.id, 200_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    await prisma.ownerStatement.create({
      data: {
        tenantId: TENANT_ID,
        propertyId: property.id,
        ownerId: owner!.id,
        periodStart: new Date('2026-07-01T07:00:00Z'),
        periodEnd: new Date('2026-08-01T07:00:00Z'),
        rentIncomeCents: 0, expensesCents: 0, managementFeeCents: 0,
        reserveWithheldCents: 20_000, ownerPayoutCents: 0, shortfallCents: 0,
        appliedFeePercentBps: 1250, reserveTargetCents: 50_000,
        closedByUserId: 'u_test',
      },
    });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.reserveAlreadyWithheldCents).toBe(20_000);
    expect(result.preview.reserveWithheldCents).toBe(30_000);
  });

  it('flags a period that is already closed', async () => {
    const { property, owner } = await seed();
    await prisma.ownerStatement.create({
      data: {
        tenantId: TENANT_ID,
        propertyId: property.id,
        ownerId: owner!.id,
        periodStart: new Date('2026-08-01T07:00:00Z'),
        periodEnd: new Date('2026-09-01T07:00:00Z'),
        rentIncomeCents: 0, expensesCents: 0, managementFeeCents: 0,
        reserveWithheldCents: 0, ownerPayoutCents: 0, shortfallCents: 0,
        appliedFeePercentBps: 1250, reserveTargetCents: 0,
        closedByUserId: 'u_test',
      },
    });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.alreadyClosed).toBe(true);
  });

  it('previews a property with no owner assigned', async () => {
    const { property } = await seed({ withOwner: false });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.ownerId).toBeNull();
  });

  it('rejects a malformed period', async () => {
    const { property } = await seed();

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-13',
    });

    expect(result).toEqual({ ok: false, status: 400, error: 'Invalid period; expected YYYY-MM' });
  });

  it('returns 404 for a property in another tenant', async () => {
    const { property } = await seed();

    const result = await previewOwnerStatement({
      tenantId: 'tenant_someone_else', propertyId: property.id, period: '2026-08',
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Property not found' });
  });
});

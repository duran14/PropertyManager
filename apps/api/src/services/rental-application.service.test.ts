import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import {
  createRentalApplication,
  getPublicRentalApplication,
  hashApplicationToken,
} from './rental-application.service.js';

const TENANT_ID = 'tenant_test_rental_application';

async function seedShowing(options: { showingId?: string } = {}) {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Rental Application Test Tenant', province: 'BC' },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, phone: '+16045557001', source: 'web', status: 'new_' },
  });
  const showing = await prisma.showing.create({
    data: {
      ...(options.showingId ? { id: options.showingId } : {}),
      tenantId: TENANT_ID,
      leadId: lead.id,
      scheduledAt: new Date(),
      status: 'confirmed',
    },
  });
  return { lead, showing };
}

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('rental application invitations', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('creates an application with a hashed token and a 14-day expiry', async () => {
    const { lead, showing } = await seedShowing();

    const { application, token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });

    expect(token).toBeTruthy();
    expect(application.tokenHash).toBe(hashApplicationToken(token));
    expect(application.tokenHash).not.toBe(token);
    expect(application.status).toBe('invited');
    const daysUntilExpiry = (application.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysUntilExpiry).toBeGreaterThan(13.9);
    expect(daysUntilExpiry).toBeLessThan(14.1);
  });

  it('looks up an application by its plaintext token', async () => {
    const { lead, showing } = await seedShowing();
    const { token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });

    const found = await getPublicRentalApplication(token);

    expect(found?.showingId).toBe(showing.id);
  });

  it('returns null for an unknown token', async () => {
    expect(await getPublicRentalApplication('not-a-real-token')).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const { lead, showing } = await seedShowing();
    const { application, token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });
    await prisma.rentalApplication.update({
      where: { id: application.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await getPublicRentalApplication(token)).toBeNull();
  });
});

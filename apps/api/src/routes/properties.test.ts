import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { propertySchema, resolveOwnerId } from './properties.js';

/**
 * Fix de seguridad (post-review de Task 6): `Property.ownerId` es una FK
 * simple a `Owner.id` sin ningún constraint compuesto que ate el Owner al
 * mismo tenant que la propiedad. Antes de este fix, `POST /` escribía
 * `parsed.data.ownerId` directo, y `PATCH /:propertyId` lo recogía sin
 * validar vía `...parsed.data` — un usuario autenticado que conociera o
 * adivinara el id de un Owner de OTRO tenant podía vincular su propiedad a
 * ese dueño ajeno.
 *
 * `resolveOwnerId` es ahora el único punto por el que ambos handlers
 * escriben `ownerId`: si esta función rechaza los ids de Owner de otro
 * tenant, ningún handler puede filtrarlos, sin importar cómo cambie el
 * resto de la ruta.
 *
 * Se prueba contra Prisma real (no `vi.mock`), igual que
 * `owner-statement.service.test.ts` y los tests de webhooks de este mismo
 * directorio: dos tenants de prueba, limpieza solo de esos tenants.
 */

const TENANT_A = 'tenant_test_resolve_owner_a';
const TENANT_B = 'tenant_test_resolve_owner_b';

async function cleanup() {
  await prisma.owner.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
}

describe('resolveOwnerId', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.tenant.upsert({
      where: { id: TENANT_A },
      update: {},
      create: { id: TENANT_A, name: 'Resolve Owner Test A', province: 'BC' },
    });
    await prisma.tenant.upsert({
      where: { id: TENANT_B },
      update: {},
      create: { id: TENANT_B, name: 'Resolve Owner Test B', province: 'BC' },
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('resolves to null when ownerId is undefined (not sent — create with no owner, or patch that leaves it untouched upstream)', async () => {
    const result = await resolveOwnerId(TENANT_A, undefined);
    expect(result).toEqual({ ok: true, ownerId: null });
  });

  it('resolves to null when ownerId is explicitly null (unassigning an owner is legitimate)', async () => {
    const result = await resolveOwnerId(TENANT_A, null);
    expect(result).toEqual({ ok: true, ownerId: null });
  });

  it('resolves to null when ownerId is an empty string', async () => {
    const result = await resolveOwnerId(TENANT_A, '');
    expect(result).toEqual({ ok: true, ownerId: null });
  });

  it('accepts an Owner that belongs to the same tenant', async () => {
    const owner = await prisma.owner.create({
      data: { tenantId: TENANT_A, firstName: 'Ana', lastName: 'Propietaria' },
    });

    const result = await resolveOwnerId(TENANT_A, owner.id);

    expect(result).toEqual({ ok: true, ownerId: owner.id });
  });

  it('rejects an Owner id that belongs to a different tenant (the cross-tenant leak this fix closes)', async () => {
    const foreignOwner = await prisma.owner.create({
      data: { tenantId: TENANT_B, firstName: 'Bruno', lastName: 'Ajeno' },
    });

    const result = await resolveOwnerId(TENANT_A, foreignOwner.id);

    expect(result).toEqual({ ok: false });
  });

  it('rejects an ownerId that does not exist at all', async () => {
    const result = await resolveOwnerId(TENANT_A, 'nonexistent-owner-id');

    expect(result).toEqual({ ok: false });
  });
});

const TENANT_SYND = 'tenant_test_syndication_fields';

describe('campos de sindicación', () => {
  beforeEach(async () => {
    await prisma.property.deleteMany({ where: { tenantId: TENANT_SYND } });
    await prisma.tenant.upsert({
      where: { id: TENANT_SYND },
      update: {},
      create: { id: TENANT_SYND, name: 'Syndication Fields Test', province: 'BC' },
    });
  });

  afterEach(async () => {
    await prisma.property.deleteMany({ where: { tenantId: TENANT_SYND } });
  });

  it('persiste yearBuilt, latitude y longitude', async () => {
    const property = await prisma.property.create({
      data: {
        tenantId: TENANT_SYND,
        name: 'Surrey Crossing',
        address: '123 King George Blvd',
        city: 'Surrey',
        province: 'BC',
        yearBuilt: 1998,
        latitude: 49.1044,
        longitude: -122.8011,
      },
    });
    expect(property.yearBuilt).toBe(1998);
    expect(property.latitude).toBeCloseTo(49.1044);
    expect(property.longitude).toBeCloseTo(-122.8011);
  });

  it('deja los tres campos en null cuando no se mandan', async () => {
    const property = await prisma.property.create({
      data: {
        tenantId: TENANT_SYND,
        name: 'Sin datos',
        address: '9 Nowhere Rd',
        city: 'Surrey',
        province: 'BC',
      },
    });
    expect(property.yearBuilt).toBeNull();
    expect(property.latitude).toBeNull();
    expect(property.longitude).toBeNull();
  });

  it('rechaza coordenadas fuera de rango', () => {
    expect(
      propertySchema.safeParse({
        name: 'X', address: 'Y', city: 'Z', province: 'BC', latitude: 200,
      }).success,
    ).toBe(false);
    expect(
      propertySchema.safeParse({
        name: 'X', address: 'Y', city: 'Z', province: 'BC', longitude: -400,
      }).success,
    ).toBe(false);
  });

  it('rechaza un año de construcción absurdo', () => {
    expect(
      propertySchema.safeParse({
        name: 'X', address: 'Y', city: 'Z', province: 'BC', yearBuilt: 12345,
      }).success,
    ).toBe(false);
  });

  it('acepta los tres campos ausentes o en null', () => {
    expect(
      propertySchema.safeParse({
        name: 'X', address: 'Y', city: 'Z', province: 'BC', yearBuilt: null,
      }).success,
    ).toBe(true);
  });
});

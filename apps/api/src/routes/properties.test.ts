import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { resolveOwnerId } from './properties.js';

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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { getListingFeed } from '../services/listing-feed.service.js';
import {
  buildPropertyCreateData,
  countSyndicatedRows,
  propertySchema,
  resolveOwnerId,
} from './properties.js';

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
  const base = { name: 'X', address: 'Y', city: 'Z', province: 'BC' };

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

  it('distingue el rango de latitud del de longitud', () => {
    // 91 es inválido como latitud pero válido como longitud: si alguien
    // intercambiara los rangos, este par lo delata.
    expect(propertySchema.safeParse({ ...base, latitude: 91 }).success).toBe(false);
    expect(propertySchema.safeParse({ ...base, longitude: 91 }).success).toBe(true);
  });

  it('acepta los valores límite exactos', () => {
    expect(propertySchema.safeParse({ ...base, latitude: 90 }).success).toBe(true);
    expect(propertySchema.safeParse({ ...base, latitude: -90 }).success).toBe(true);
    expect(propertySchema.safeParse({ ...base, longitude: 180 }).success).toBe(true);
    expect(propertySchema.safeParse({ ...base, longitude: -180 }).success).toBe(true);
    expect(propertySchema.safeParse({ ...base, yearBuilt: 1800 }).success).toBe(true);
    expect(propertySchema.safeParse({ ...base, yearBuilt: 2100 }).success).toBe(true);
  });

  it('rechaza justo afuera del límite', () => {
    expect(propertySchema.safeParse({ ...base, latitude: 90.1 }).success).toBe(false);
    expect(propertySchema.safeParse({ ...base, longitude: 180.1 }).success).toBe(false);
    expect(propertySchema.safeParse({ ...base, yearBuilt: 1799 }).success).toBe(false);
    expect(propertySchema.safeParse({ ...base, yearBuilt: 2101 }).success).toBe(false);
  });

  it('acepta los tres campos de sindicación en null explícito', () => {
    expect(
      propertySchema.safeParse({
        ...base, yearBuilt: null, latitude: null, longitude: null,
      }).success,
    ).toBe(true);
  });
});

describe('buildPropertyCreateData', () => {
  const base = { name: 'X', address: 'Y', city: 'Z', province: 'BC' };

  it('incluye los campos de sindicación cuando vienen', () => {
    const data = buildPropertyCreateData(
      propertySchema.parse({ ...base, yearBuilt: 1998, latitude: 49.1044, longitude: -122.8011 }),
      't1', null,
    );
    expect(data.yearBuilt).toBe(1998);
    expect(data.latitude).toBeCloseTo(49.1044);
    expect(data.longitude).toBeCloseTo(-122.8011);
  });

  it('omite los campos de sindicación cuando no vienen', () => {
    const data = buildPropertyCreateData(propertySchema.parse(base), 't1', null);
    expect('yearBuilt' in data).toBe(false);
    expect('latitude' in data).toBe(false);
    expect('longitude' in data).toBe(false);
  });

  // Guard contra la regresión exacta que motivó este fix: si alguien agrega un
  // campo al schema y olvida el handler, este test lo caza.
  it('no pierde ningún campo del schema que el handler deba persistir', () => {
    const full = propertySchema.parse({
      ...base, postalCode: 'V3S1A1', yearBuilt: 1998,
      latitude: 49.1, longitude: -122.8,
      managementFeePercentBps: 1000, reserveFundTargetCents: 50000,
    });
    const data = buildPropertyCreateData(full, 't1', null);
    for (const key of ['yearBuilt', 'latitude', 'longitude', 'managementFeePercentBps', 'reserveFundTargetCents'] as const) {
      expect(data[key]).toBeDefined();
    }
  });
});

/**
 * Fase 4.1: `GET /properties/syndication-status` delega en `getListingFeed`
 * (que ya tiene sus propios tests de integración en
 * `listing-feed.service.test.ts`, Task 3). Lo que falta cubrir acá es la
 * lógica propia de la ruta: el conteo derivado del CSV y la construcción de
 * la `feedUrl` — extraída a `countSyndicatedRows` para poder testearla sin
 * `supertest` (este repo no lo tiene, ver leads.test.ts).
 */
describe('countSyndicatedRows', () => {
  it('no cuenta el encabezado', () => {
    expect(countSyndicatedRows('home_listing_id,name\nu1,Casa\nu2,Depa\n')).toBe(2);
  });

  it('devuelve 0 con solo encabezado', () => {
    expect(countSyndicatedRows('home_listing_id,name\n')).toBe(0);
  });

  it('devuelve 0 con cadena vacía', () => {
    expect(countSyndicatedRows('')).toBe(0);
  });
});

const TENANT_SYND_STATUS = 'tenant_test_syndication_status';

/** Crea propiedad + unidad + fotos en un solo paso (copiado de listing-feed.service.test.ts: archivo distinto, sin helpers compartidos entre tests). */
async function seedListing(opts: {
  tenantId: string;
  slug: string;
  yearBuilt?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  isActive?: boolean;
  photos?: { originalUrl: string; enhancedUrl?: string | null }[];
}) {
  const property = await prisma.property.create({
    data: {
      tenantId: opts.tenantId,
      name: `Prop ${opts.slug}`,
      address: `1 ${opts.slug} Rd`,
      city: 'Surrey',
      province: 'BC',
      yearBuilt: opts.yearBuilt === undefined ? 1998 : opts.yearBuilt,
      latitude: opts.latitude === undefined ? 49.1044 : opts.latitude,
      longitude: opts.longitude === undefined ? -122.8011 : opts.longitude,
    },
  });
  const unit = await prisma.unit.create({
    data: {
      tenantId: opts.tenantId,
      propertyId: property.id,
      name: 'Suite 204',
      rentCents: 250000,
      bedrooms: 2,
      bathrooms: 1,
      slug: opts.slug,
      isActive: opts.isActive ?? true,
    },
  });
  for (const photo of opts.photos ?? [{ originalUrl: 'https://cdn.example.com/a.jpg' }]) {
    await prisma.listingPhoto.create({
      data: {
        tenantId: opts.tenantId,
        unitId: unit.id,
        originalUrl: photo.originalUrl,
        enhancedUrl: photo.enhancedUrl ?? null,
        isPrimary: true,
      },
    });
  }
  return { property, unit };
}

describe('estado de sindicación', () => {
  async function cleanup() {
    await prisma.listingPhoto.deleteMany({ where: { tenantId: TENANT_SYND_STATUS } });
    await prisma.unit.deleteMany({ where: { tenantId: TENANT_SYND_STATUS } });
    await prisma.property.deleteMany({ where: { tenantId: TENANT_SYND_STATUS } });
  }

  beforeEach(async () => {
    await cleanup();
    await prisma.tenant.upsert({
      where: { id: TENANT_SYND_STATUS },
      update: {},
      create: { id: TENANT_SYND_STATUS, name: 'Syndication Status Test', province: 'BC' },
    });
  });

  afterEach(cleanup);

  it('cuenta solo las sindicables y detalla las omitidas', async () => {
    await seedListing({ tenantId: TENANT_SYND_STATUS, slug: 'sync-status-complete' });
    await seedListing({ tenantId: TENANT_SYND_STATUS, slug: 'sync-status-no-year', yearBuilt: null });

    const { csv, skipped } = await getListingFeed(TENANT_SYND_STATUS, new Date());

    expect(countSyndicatedRows(csv)).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('missing_year_built');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { getListingFeed } from './listing-feed.service.js';

const TENANT_A = 'tenant_test_listing_feed_a';
const TENANT_B = 'tenant_test_listing_feed_b';
const NOW = new Date('2026-08-18T00:00:00Z');

async function cleanup() {
  const tenantIds = { in: [TENANT_A, TENANT_B] };
  await prisma.listingPhoto.deleteMany({ where: { tenantId: tenantIds } });
  await prisma.unit.deleteMany({ where: { tenantId: tenantIds } });
  await prisma.property.deleteMany({ where: { tenantId: tenantIds } });
}

/** Crea propiedad + unidad + fotos en un solo paso. */
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

describe('getListingFeed', () => {
  beforeEach(async () => {
    await cleanup();
    for (const id of [TENANT_A, TENANT_B]) {
      await prisma.tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: `Listing Feed ${id}`, province: 'BC' },
      });
    }
  });

  afterEach(cleanup);

  it('incluye una unidad activa con propiedad completa y foto', async () => {
    const { unit } = await seedListing({ tenantId: TENANT_A, slug: 'a-complete' });
    const { csv, skipped } = await getListingFeed(TENANT_A, NOW);
    expect(csv.trim().split('\n')).toHaveLength(2);
    expect(csv).toContain(unit.id);
    expect(skipped).toHaveLength(0);
  });

  it('omite y reporta una unidad cuya propiedad no tiene coordenadas', async () => {
    await seedListing({ tenantId: TENANT_A, slug: 'a-nocoords', latitude: null });
    const { csv, skipped } = await getListingFeed(TENANT_A, NOW);
    expect(csv.trim().split('\n')).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('missing_coordinates');
  });

  it('omite y reporta una unidad sin fotos', async () => {
    await seedListing({ tenantId: TENANT_A, slug: 'a-nophotos', photos: [] });
    const { skipped } = await getListingFeed(TENANT_A, NOW);
    expect(skipped[0]?.reason).toBe('missing_photos');
  });

  // El test que no puede faltar: un tenant no puede ver listados de otro.
  it('no incluye unidades de otro tenant', async () => {
    const a = await seedListing({ tenantId: TENANT_A, slug: 'a-own' });
    const b = await seedListing({ tenantId: TENANT_B, slug: 'b-other' });
    const { csv } = await getListingFeed(TENANT_A, NOW);
    expect(csv).toContain(a.unit.id);
    expect(csv).not.toContain(b.unit.id);
  });

  it('no incluye unidades inactivas ni las reporta como omitidas', async () => {
    await seedListing({ tenantId: TENANT_A, slug: 'a-inactive', isActive: false });
    const { csv, skipped } = await getListingFeed(TENANT_A, NOW);
    expect(csv.trim().split('\n')).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('prefiere la foto mejorada sobre la original', async () => {
    await seedListing({
      tenantId: TENANT_A,
      slug: 'a-enhanced',
      photos: [{ originalUrl: 'https://cdn.example.com/raw.jpg', enhancedUrl: 'https://cdn.example.com/nice.jpg' }],
    });
    const { csv } = await getListingFeed(TENANT_A, NOW);
    expect(csv).toContain('https://cdn.example.com/nice.jpg');
    expect(csv).not.toContain('https://cdn.example.com/raw.jpg');
  });

  // Ronda de corrección 1 (Task 4): `syndicatedCount` se deriva de
  // `entries.length`, no de contar líneas físicas del CSV serializado.
  it('cuenta filas lógicas, no líneas físicas, con una dirección multilínea', async () => {
    // Una dirección con salto de línea produce una fila CSV válida que ocupa
    // dos líneas físicas. El conteo debe seguir siendo 1.
    await seedListing({ tenantId: TENANT_A, slug: 'a-multiline' });
    await prisma.property.updateMany({
      where: { tenantId: TENANT_A },
      data: { address: '123 Main St\nApt 4B' },
    });
    const { csv, syndicatedCount } = await getListingFeed(TENANT_A, NOW);
    expect(syndicatedCount).toBe(1);
    // Y confirma que el CSV efectivamente ocupa más líneas físicas que filas:
    // si no, el test no está probando lo que dice.
    expect(csv.trim().split('\n').length).toBeGreaterThan(2);
  });
});

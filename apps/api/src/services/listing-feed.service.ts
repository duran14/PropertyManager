import {
  buildListingFeed,
  serializeListingFeedCsv,
  type ListingFeedInput,
  type SkippedListing,
} from '@property-manager/core';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';

/**
 * Fase 4.1: arma el feed de sindicación de un tenant.
 *
 * Extraída de la ruta (en vez de vivir inline en el handler) para poder
 * testearla directo contra la base — este repo no tiene infraestructura de
 * supertest (ver leads.test.ts).
 */
export async function getListingFeed(
  tenantId: string,
  now: Date,
): Promise<{ csv: string; skipped: SkippedListing[] }> {
  const units = await prisma.unit.findMany({
    where: { tenantId, isActive: true },
    include: {
      property: {
        select: {
          name: true, address: true, city: true, province: true,
          yearBuilt: true, latitude: true, longitude: true,
        },
      },
      listingPhotos: {
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        take: 10,
      },
    },
    orderBy: { rentCents: 'asc' },
  });

  const inputs: ListingFeedInput[] = units.map((unit) => ({
    unitId: unit.id,
    unitName: unit.name,
    slug: unit.slug,
    rentCents: unit.rentCents,
    bedrooms: unit.bedrooms,
    bathrooms: unit.bathrooms,
    availableFrom: unit.availableFrom,
    isActive: unit.isActive,
    propertyName: unit.property.name,
    streetAddress: unit.property.address,
    city: unit.property.city,
    province: unit.property.province,
    yearBuilt: unit.property.yearBuilt,
    latitude: unit.property.latitude,
    longitude: unit.property.longitude,
    // Misma preferencia que la vitrina pública: la foto mejorada si existe.
    photoUrls: unit.listingPhotos.map((photo) => photo.enhancedUrl ?? photo.originalUrl),
  }));

  const { entries, skipped } = buildListingFeed(inputs, now, {
    webUrl: getEnv().WEB_URL,
    tenantId,
  });

  return { csv: serializeListingFeedCsv(entries), skipped };
}

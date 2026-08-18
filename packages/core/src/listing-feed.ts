/**
 * Feed de sindicación de listados (Fase 4.1).
 *
 * Puro: sin Prisma, sin I/O, sin red. La fecha de referencia entra como
 * parámetro para que los tests no dependan del día en que corren — este repo
 * ya tuvo dos tests con fechas quemadas que se rompieron solos al pasar el
 * calendario.
 *
 * Formato: catálogo de bienes raíces de Meta (`home_listings`). Los campos
 * obligatorios que Meta exige y el modelo no puede derivar de la dirección
 * (año de construcción y coordenadas) se capturan a mano en Property; una
 * unidad cuya propiedad no los tenga se OMITE y se reporta, en vez de emitir
 * una fila que Meta rechazaría en silencio.
 */

export interface ListingFeedInput {
  unitId: string;
  unitName: string;
  slug: string;
  rentCents: number;
  bedrooms: number | null;
  bathrooms: number | null;
  availableFrom: Date | null;
  isActive: boolean;
  propertyName: string;
  streetAddress: string;
  city: string;
  province: string;
  yearBuilt: number | null;
  latitude: number | null;
  longitude: number | null;
  photoUrls: string[];
}

export interface ListingFeedEntry {
  homeListingId: string;
  name: string;
  price: number;
  currency: 'CAD';
  availability: 'available_now' | 'available_soon';
  url: string;
  yearBuilt: number;
  numBeds: number | null;
  numBaths: number | null;
  address: {
    streetAddress: string;
    city: string;
    region: string;
    country: 'CA';
    latitude: number;
    longitude: number;
  };
  imageUrls: string[];
}

export type SkippedListingReason =
  | 'missing_year_built'
  | 'missing_coordinates'
  | 'missing_photos';

export interface SkippedListing {
  unitId: string;
  unitName: string;
  propertyName: string;
  reason: SkippedListingReason;
}

export interface ListingFeedContext {
  webUrl: string;
  tenantId: string;
}

const MAX_FEED_IMAGES = 10;
const CURRENCY = 'CAD' as const;
const COUNTRY = 'CA' as const;

export function buildListingFeed(
  inputs: ListingFeedInput[],
  now: Date,
  context: ListingFeedContext,
): { entries: ListingFeedEntry[]; skipped: SkippedListing[] } {
  const entries: ListingFeedEntry[] = [];
  const skipped: SkippedListing[] = [];

  for (const input of inputs) {
    if (!input.isActive) {
      continue;
    }

    if (input.yearBuilt == null) {
      skipped.push({
        unitId: input.unitId,
        unitName: input.unitName,
        propertyName: input.propertyName,
        reason: 'missing_year_built',
      });
      continue;
    }

    if (input.latitude == null || input.longitude == null) {
      skipped.push({
        unitId: input.unitId,
        unitName: input.unitName,
        propertyName: input.propertyName,
        reason: 'missing_coordinates',
      });
      continue;
    }

    if (input.photoUrls.length === 0) {
      skipped.push({
        unitId: input.unitId,
        unitName: input.unitName,
        propertyName: input.propertyName,
        reason: 'missing_photos',
      });
      continue;
    }

    const availability: ListingFeedEntry['availability'] =
      input.availableFrom == null || input.availableFrom.getTime() <= now.getTime()
        ? 'available_now'
        : 'available_soon';

    const baseUrl = context.webUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/listings/${input.slug}?tenant=${encodeURIComponent(context.tenantId)}`;

    entries.push({
      homeListingId: input.unitId,
      name: `${input.propertyName} — ${input.unitName}`,
      price: input.rentCents / 100,
      currency: CURRENCY,
      availability,
      url,
      yearBuilt: input.yearBuilt,
      numBeds: input.bedrooms,
      numBaths: input.bathrooms,
      address: {
        streetAddress: input.streetAddress,
        city: input.city,
        region: input.province,
        country: COUNTRY,
        latitude: input.latitude,
        longitude: input.longitude,
      },
      imageUrls: input.photoUrls.slice(0, MAX_FEED_IMAGES),
    });
  }

  return { entries, skipped };
}

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvCell(value: string | number | null): string {
  if (value == null) {
    return '';
  }
  return escapeCsvField(String(value));
}

const CSV_HEADER = [
  'home_listing_id',
  'name',
  'price',
  'currency',
  'availability',
  'url',
  'year_built',
  'num_beds',
  'num_baths',
  'address.street_address',
  'address.city',
  'address.region',
  'address.country',
  'address.latitude',
  'address.longitude',
  ...Array.from({ length: MAX_FEED_IMAGES }, (_, i) => `image[${i}].url`),
];

export function serializeListingFeedCsv(entries: ListingFeedEntry[]): string {
  const lines = [CSV_HEADER.join(',')];

  for (const entry of entries) {
    const imageCells: string[] = [];
    for (let i = 0; i < MAX_FEED_IMAGES; i += 1) {
      imageCells.push(toCsvCell(entry.imageUrls[i] ?? null));
    }

    const row = [
      toCsvCell(entry.homeListingId),
      toCsvCell(entry.name),
      toCsvCell(entry.price),
      toCsvCell(entry.currency),
      toCsvCell(entry.availability),
      toCsvCell(entry.url),
      toCsvCell(entry.yearBuilt),
      toCsvCell(entry.numBeds),
      toCsvCell(entry.numBaths),
      toCsvCell(entry.address.streetAddress),
      toCsvCell(entry.address.city),
      toCsvCell(entry.address.region),
      toCsvCell(entry.address.country),
      toCsvCell(entry.address.latitude),
      toCsvCell(entry.address.longitude),
      ...imageCells,
    ];

    lines.push(row.join(','));
  }

  return `${lines.join('\n')}\n`;
}

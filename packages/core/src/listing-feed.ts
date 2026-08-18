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

// Minor 4 (ronda de corrección final): exportado porque `listing-feed.service.ts`
// tenía un `take: 10` quemado por separado — si este límite sube (Meta lo
// amplía), el `take` de Prisma se queda atrás y las columnas `image[10..].url`
// del CSV salen siempre vacías sin que nada lo señale.
export const MAX_FEED_IMAGES = 10;
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

// Minor 3 (ronda de corrección final): neutraliza CSV injection. Excel y
// Google Sheets interpretan una celda que EMPIEZA con `=`, `+` o `@` como el
// inicio de una fórmula; prefijarla con un apóstrofo la fuerza a texto plano
// sin cambiar el valor visible. El triaje original asumía que todo el
// contenido del feed lo captura staff autenticado del tenant, pero
// `image[N].url` sale de `photo.enhancedUrl`, que escribe el webhook sin
// autenticar de Autoenhance (`apps/api/src/routes/photos.ts`) sin validarlo
// como URL — así que una celda puede traer contenido no confiable.
//
// Deliberadamente NO se incluye `-`: una longitud negativa (todo Norteamérica,
// ej. `-122.8011`) es un valor legítimo y numérico, no el inicio de una
// fórmula de Excel; sanitizarla corrompería un dato que Meta requiere.
const CSV_FORMULA_PREFIXES = ['=', '+', '@'];

function escapeCsvField(value: string): string {
  const needsFormulaGuard = CSV_FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));
  const guarded = needsFormulaGuard ? `'${value}` : value;

  // Minor 6 (ronda de corrección final): `\r` solo (sin `\n` de por medio)
  // no estaba cubierto — un parser que trate `\r` como fin de registro
  // partiría la fila. `\r\n` ya quedaba cubierto por contener `\n`.
  if (guarded.includes(',') || guarded.includes('"') || guarded.includes('\n') || guarded.includes('\r')) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
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

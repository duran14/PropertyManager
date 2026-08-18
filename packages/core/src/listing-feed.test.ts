import { describe, expect, it } from 'vitest';
import {
  buildListingFeed,
  serializeListingFeedCsv,
  type ListingFeedInput,
} from './listing-feed.js';

const NOW = new Date('2026-08-18T00:00:00Z');

function makeInput(overrides: Partial<ListingFeedInput> = {}): ListingFeedInput {
  return {
    unitId: 'u1',
    unitName: 'Suite 204',
    slug: 'surrey-crossing-suite-204',
    rentCents: 250000,
    bedrooms: 2,
    bathrooms: 1.5,
    availableFrom: null,
    isActive: true,
    propertyName: 'Surrey Crossing',
    streetAddress: '123 King George Blvd',
    city: 'Surrey',
    province: 'BC',
    yearBuilt: 1998,
    latitude: 49.1044,
    longitude: -122.8011,
    photoUrls: ['https://cdn.example.com/a.jpg'],
    ...overrides,
  };
}

const BASE = { webUrl: 'https://app.example.com', tenantId: 't1' };

describe('buildListingFeed — qué entra y qué se omite', () => {
  it('incluye una unidad completa', () => {
    const result = buildListingFeed([makeInput()], NOW, BASE);
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('omite y reporta una unidad sin año de construcción', () => {
    const result = buildListingFeed([makeInput({ yearBuilt: null })], NOW, BASE);
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toEqual([
      { unitId: 'u1', unitName: 'Suite 204', propertyName: 'Surrey Crossing', reason: 'missing_year_built' },
    ]);
  });

  it('omite y reporta una unidad sin coordenadas', () => {
    const result = buildListingFeed([makeInput({ latitude: null })], NOW, BASE);
    expect(result.skipped[0]?.reason).toBe('missing_coordinates');
  });

  it('omite y reporta una unidad sin fotos', () => {
    const result = buildListingFeed([makeInput({ photoUrls: [] })], NOW, BASE);
    expect(result.skipped[0]?.reason).toBe('missing_photos');
  });

  // Una unidad inactiva no está a la venta: no es candidata y NO se reporta
  // como omitida, o el PM vería ruido permanente por cada unidad rentada.
  it('ignora una unidad inactiva sin reportarla como omitida', () => {
    const result = buildListingFeed([makeInput({ isActive: false, yearBuilt: null })], NOW, BASE);
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('buildListingFeed — mapeo de campos', () => {
  it('convierte centavos a unidades de moneda y fija CAD/CA', () => {
    const [entry] = buildListingFeed([makeInput({ rentCents: 250000 })], NOW, BASE).entries;
    expect(entry?.price).toBe(2500);
    expect(entry?.currency).toBe('CAD');
    expect(entry?.address.country).toBe('CA');
  });

  it('arma la url pública con el slug y el tenant', () => {
    const [entry] = buildListingFeed([makeInput()], NOW, BASE).entries;
    expect(entry?.url).toBe('https://app.example.com/listings/surrey-crossing-suite-204?tenant=t1');
  });

  it('marca available_now cuando no hay fecha de disponibilidad', () => {
    const [entry] = buildListingFeed([makeInput({ availableFrom: null })], NOW, BASE).entries;
    expect(entry?.availability).toBe('available_now');
  });

  it('marca available_now cuando la fecha ya pasó', () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    const [entry] = buildListingFeed([makeInput({ availableFrom: past })], NOW, BASE).entries;
    expect(entry?.availability).toBe('available_now');
  });

  it('marca available_soon cuando la fecha es futura', () => {
    const future = new Date(NOW.getTime() + 86_400_000);
    const [entry] = buildListingFeed([makeInput({ availableFrom: future })], NOW, BASE).entries;
    expect(entry?.availability).toBe('available_soon');
  });

  it('recorta a 10 imágenes', () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    const [entry] = buildListingFeed([makeInput({ photoUrls: many })], NOW, BASE).entries;
    expect(entry?.imageUrls).toHaveLength(10);
    expect(entry?.imageUrls[0]).toBe('https://cdn.example.com/0.jpg');
  });
});

describe('serializeListingFeedCsv', () => {
  it('emite encabezado y una fila por entrada', () => {
    const { entries } = buildListingFeed([makeInput()], NOW, BASE);
    const csv = serializeListingFeedCsv(entries);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('home_listing_id');
    expect(lines[0]).toContain('address.street_address');
    expect(lines[0]).toContain('image[0].url');
    expect(lines[1]).toContain('u1');
  });

  // Una dirección con coma rompería el CSV si no se citara.
  it('cita los campos que contienen comas y escapa las comillas', () => {
    const { entries } = buildListingFeed(
      [makeInput({ streetAddress: '123 King George Blvd, Unit "A"' })],
      NOW,
      BASE,
    );
    const csv = serializeListingFeedCsv(entries);
    expect(csv).toContain('"123 King George Blvd, Unit ""A"""');
  });

  it('emite solo el encabezado cuando no hay entradas', () => {
    const csv = serializeListingFeedCsv([]);
    expect(csv.trim().split('\n')).toHaveLength(1);
  });
});

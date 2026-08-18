# Feed de sindicación de listados (Fase 4.1) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** exponer un feed público de listados por tenant, en el formato de catálogo de bienes raíces de Meta, que cualquier portal de sindicación pueda consumir por URL.

**Architecture:** tres capas con frontera clara. `packages/core` tiene dos funciones puras (construir entradas y serializar a CSV), sin I/O ni Prisma. `apps/api` expone una ruta pública que consulta y delega. `apps/web` muestra al PM qué listados quedaron fuera del feed y por qué. Las tareas van en orden estricto: 2 consume el schema de 1, 3 consume las funciones de 2, y 4 consume la ruta de 3.

**Tech Stack:** TypeScript, Node 24, Express, Prisma, Vitest, React 18 + Vite, pnpm workspaces.

## Global Constraints

- Las funciones de `packages/core` son **puras**: sin Prisma, sin `fs`, sin red, sin `Date.now()` implícito — la fecha de referencia se pasa como parámetro para que los tests no dependan del día en que corren.
- La ruta del feed **solo** expone unidades activas del tenant pedido. Nunca datos de solicitantes, dueños ni contabilidad.
- El aislamiento por `tenantId` se aplica en la query, siempre.
- La allowlist de qué entra al feed es: `Unit.isActive === true` **y** `Property.yearBuilt/latitude/longitude` no nulos **y** al menos una `ListingPhoto`.
- Una unidad **inactiva** no es candidata y NO se reporta como omitida. Solo se reportan unidades activas que fallan los otros criterios.
- Moneda: constante `'CAD'`. País: constante `'CA'`.
- Máximo **10 imágenes** por listado (`image[0]`..`image[9]`), principal primero.
- Migraciones **aditivas**: columnas nuevas nullable, sin backfill, sin `NOT NULL`.
- Nunca uses `git stash`. Nunca corras `prisma migrate reset`, `prisma db push` ni `migrate dev` destructivo contra la base de datos.
- Correr `pnpm --filter @property-manager/api exec tsc --noEmit` y `pnpm --filter @property-manager/web exec tsc --noEmit` antes de cada commit; ambos limpios.
- Baseline al empezar: `apps/api` 756/756, `packages/core` 91/91, `packages/adapters` 85/85, `apps/web` 2/2.

---

### Task 1: Campos de sindicación en `Property`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (modelo `Property`, ~línea 96-122)
- Create: `apps/api/prisma/migrations/<timestamp>_add_property_syndication_fields/migration.sql` (generada)
- Modify: `apps/api/src/routes/properties.ts:10-19` (`propertySchema`)
- Modify: `apps/web/src/lib/types.ts` (tipo `PropertyRecord`)
- Modify: `apps/web/src/pages/PropertiesPage.tsx` (`emptyProperty`, formulario, `startEditProperty`)

**Interfaces:**
- Consumes: nada.
- Produces: `Property.yearBuilt: number | null`, `Property.latitude: number | null`, `Property.longitude: number | null`, persistidos y editables desde la UI.

**Contexto que el implementador no puede adivinar:** `Property` ya tiene un patrón de campos opcionales de configuración agregados en una fase previa (`ownerId`, `managementFeePercentBps`, `reserveFundTargetCents`). El schema del repo prohíbe `Float` **para dinero** (por eso la comisión va en basis points enteros y los montos en centavos), pero `Float` es correcto para coordenadas — hay precedente en `Unit.bathrooms Float?`. `PropertiesPage.tsx` convierte unidades en la frontera de la mutación (porcentaje legible ↔ basis points); estos tres campos **no** necesitan conversión, se capturan y guardan tal cual.

- [ ] **Step 1: Agregar las columnas al schema**

En `apps/api/prisma/schema.prisma`, dentro de `model Property`, después de `reserveFundTargetCents`:

```prisma
  // Fase 4.1: campos que el catálogo de bienes raíces de Meta exige y que
  // no se pueden derivar de la dirección sin geocodificar. Se capturan a
  // mano una sola vez por propiedad; una propiedad sin ellos queda fuera
  // del feed de sindicación (ver buildListingFeed en packages/core).
  yearBuilt               Int?
  latitude                Float?
  longitude               Float?
```

- [ ] **Step 2: Generar la migración**

Run: `pnpm --filter @property-manager/api exec prisma migrate dev --name add_property_syndication_fields --create-only`

Luego abre el `.sql` generado y **verifica que sea aditivo**: solo `ADD COLUMN`, sin `DROP`, sin `NOT NULL`, sin `DEFAULT` que reescriba filas. Debe verse así:

```sql
ALTER TABLE "properties" ADD COLUMN "yearBuilt" INTEGER;
ALTER TABLE "properties" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "properties" ADD COLUMN "longitude" DOUBLE PRECISION;
```

Si contiene cualquier otra cosa, **detente y repórtalo** — no la apliques.

- [ ] **Step 3: Aplicar la migración y regenerar el cliente**

Run: `pnpm --filter @property-manager/api exec prisma migrate deploy`
Run: `pnpm --filter @property-manager/api exec prisma generate`

- [ ] **Step 4: Aceptar los campos en la API**

En `apps/api/src/routes/properties.ts`, agregar a `propertySchema` (~línea 10-19):

```ts
  yearBuilt: z.number().int().min(1800).max(2100).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
```

Los rangos no son decorativos: una latitud de 200 o un año de 12345 son datos basura que Meta rechazaría, y es más barato pararlos acá.

No hace falta tocar los handlers: `POST /` y `PATCH /:propertyId` ya hacen spread de `parsed.data` al `create`/`update`.

- [ ] **Step 5: Escribir el test de la ruta**

**No existe ningún helper `createTestProperty` en ese archivo** — el patrón real es
tenant ids quemados, `prisma.tenant.upsert` en `beforeEach`, limpieza acotada a
esos tenants, y probar funciones exportadas directo (sin `supertest`). Sigue ese
patrón. Primero, exporta el schema desde `properties.ts` (hoy es `const` privado):

```ts
export const propertySchema = z.object({ /* … sin cambios … */ });
```

Luego agrega a `apps/api/src/routes/properties.test.ts`:

```ts
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
```

Importa `propertySchema` desde `./properties.js` junto al `resolveOwnerId` que el
archivo ya importa.

- [ ] **Step 6: Correr los tests**

Run: `pnpm --filter @property-manager/api exec vitest run src/routes/properties.test.ts`
Expected: PASS, incluidos los 3 nuevos.

- [ ] **Step 7: Exponer los campos en el frontend**

En `apps/web/src/lib/types.ts`, agregar al tipo `PropertyRecord`:

```ts
  yearBuilt: number | null;
  latitude: number | null;
  longitude: number | null;
```

En `apps/web/src/pages/PropertiesPage.tsx`:
- Agregar a `emptyProperty`: `yearBuilt: ''`, `latitude: ''`, `longitude: ''` (strings, como el resto del formulario).
- Agregar tres inputs al formulario de propiedad, agrupados bajo una etiqueta que explique para qué son (ej. "Listing syndication — required to publish this property to listing portals"), con `type="number"` y `step="any"` en las coordenadas.
- En la mutación, convertir `'' → null` y string → número antes de mandar (el resto del formulario ya hace conversiones en esa frontera; sigue ese patrón).
- En `startEditProperty`, cargar los valores existentes a string (`?? ''`).

- [ ] **Step 8: Verificar typechecks**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Run: `pnpm --filter @property-manager/web exec tsc --noEmit`
Expected: sin salida, exit 0 en ambos.

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/routes/properties.ts apps/api/src/routes/properties.test.ts apps/web/src/lib/types.ts apps/web/src/pages/PropertiesPage.tsx
git commit -m "feat: capturar ano de construccion y coordenadas de la propiedad"
```

---

### Task 2: Constructor y serializador del feed (puros)

**Files:**
- Create: `packages/core/src/listing-feed.ts`
- Create: `packages/core/src/listing-feed.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json` (mapa `exports`)

**Interfaces:**
- Consumes: los campos de Task 1 (`yearBuilt`, `latitude`, `longitude`), pero como datos de entrada — este módulo no importa Prisma.
- Produces:
  - `type ListingFeedInput` — la forma de entrada (ver Step 3).
  - `type ListingFeedEntry` — una entrada normalizada del feed.
  - `type SkippedListing = { unitId: string; unitName: string; propertyName: string; reason: 'missing_year_built' | 'missing_coordinates' | 'missing_photos' }`
  - `interface ListingFeedContext { webUrl: string; tenantId: string }`
  - `buildListingFeed(inputs: ListingFeedInput[], now: Date, context: ListingFeedContext): { entries: ListingFeedEntry[]; skipped: SkippedListing[] }` — tres parámetros, en ese orden.
  - `serializeListingFeedCsv(entries: ListingFeedEntry[]): string`

**Contexto que el implementador no puede adivinar:** `packages/core` es un paquete puro sin dependencias de runtime más allá de `zod` — **no** importes Prisma ni nada de `apps/api` acá. El mapa `exports` de `package.json` lista cada subpath explícitamente (`"./id-document": "./src/id-document.ts"`); hay que agregar el nuevo igual. Los tests de este paquete son unitarios, sin base de datos.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `packages/core/src/listing-feed.test.ts`:

```ts
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
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `pnpm --filter @property-manager/core exec vitest run src/listing-feed.test.ts`
Expected: FAIL — "Failed to resolve import './listing-feed.js'"

- [ ] **Step 3: Implementar el módulo**

Crear `packages/core/src/listing-feed.ts`. Estructura esperada:

```ts
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

export function buildListingFeed(
  inputs: ListingFeedInput[],
  now: Date,
  context: ListingFeedContext,
): { entries: ListingFeedEntry[]; skipped: SkippedListing[] } {
  // Implementación: por cada input activo, evaluar los tres criterios en el
  // orden year_built → coordenadas → fotos (para que la razón reportada sea
  // determinista cuando falta más de uno), y construir la entrada o el
  // registro de omisión.
}

export function serializeListingFeedCsv(entries: ListingFeedEntry[]): string {
  // Encabezado con los nombres de campo de la Graph API, aplanando objetos
  // con notación de punto y listas con notación indexada.
}
```

Requisitos concretos de la implementación:

- El orden de evaluación de los criterios es `missing_year_built` → `missing_coordinates` → `missing_photos`. Si faltan varios, se reporta el primero de ese orden — así la razón es determinista y el test no depende del orden de las condiciones.
- `missing_coordinates` cubre el caso de que falte `latitude`, `longitude`, o ambas.
- `name` de la entrada: `` `${propertyName} — ${unitName}` ``.
- `url`: `` `${webUrl.replace(/\/+$/, '')}/listings/${slug}?tenant=${encodeURIComponent(tenantId)}` `` — quita la diagonal final del `webUrl` como ya hacen otras partes del repo, y codifica el tenant.
- `price`: `rentCents / 100`.
- Encabezado CSV, en este orden exacto:
  `home_listing_id,name,price,currency,availability,url,year_built,num_beds,num_baths,address.street_address,address.city,address.region,address.country,address.latitude,address.longitude,image[0].url,...,image[9].url`
  Las 10 columnas de imagen se emiten siempre; las que no tengan foto van vacías.
- Escapado CSV: si un valor contiene coma, comilla doble o salto de línea, se envuelve en comillas dobles y las comillas internas se duplican (`"` → `""`). Es la regla de RFC 4180 — no inventes otra.
- Valores nulos (`num_beds`, `num_baths`) se emiten como celda vacía.

- [ ] **Step 4: Exportar el módulo**

En `packages/core/src/index.ts`, agregar al final:

```ts
export * from './listing-feed.js';
```

En `packages/core/package.json`, agregar al mapa `exports`, junto a las entradas que ya están:

```json
    "./listing-feed": "./src/listing-feed.ts"
```

- [ ] **Step 5: Correr los tests**

Run: `pnpm --filter @property-manager/core exec vitest run src/listing-feed.test.ts`
Expected: PASS — los 14 tests.

- [ ] **Step 6: Verificar que no se rompió el resto del paquete**

Run: `pnpm --filter @property-manager/core exec vitest run`
Expected: PASS — 105 tests (91 baseline + 14 nuevos).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/listing-feed.ts packages/core/src/listing-feed.test.ts packages/core/src/index.ts packages/core/package.json
git commit -m "feat: constructor y serializador del feed de listados"
```

---

### Task 3: Ruta pública del feed

**Files:**
- Modify: `apps/api/src/routes/leads.ts` (agregar ruta al `publicRouter`)
- Test: `apps/api/src/routes/leads.test.ts`
- Create: `apps/api/src/services/listing-feed.service.ts`
- Create: `apps/api/src/services/listing-feed.service.test.ts`

**Interfaces:**
- Consumes: `buildListingFeed`, `serializeListingFeedCsv`, `ListingFeedInput` de `@property-manager/core`; los campos de `Property` de Task 1.
- Produces: `getListingFeed(tenantId: string, now: Date): Promise<{ csv: string; skipped: SkippedListing[] }>` exportado de `listing-feed.service.ts`; ruta `GET /public/listing-feed?tenant={tenantId}`.

**Contexto que el implementador no puede adivinar:** este repo **no tiene `supertest`** — `leads.test.ts` verifica el wiring de rutas haciendo grep sobre el texto fuente, y la lógica real se prueba en tests de integración contra una función de servicio extraída del handler. Ese es el patrón establecido, y por eso esta tarea crea `listing-feed.service.ts` en vez de meter la lógica inline. La convención de `leads.test.ts` es un `const routeSource` de scope de describe construido con `join(process.cwd(), 'src', 'routes', 'leads.ts')`. El `publicRouter` ya existe y se exporta desde `leads.ts`; las rutas públicas existentes leen el tenant de `req.headers['x-tenant-id'] ?? req.query.tenant`, pero **esta ruta debe leer solo `req.query.tenant`**: el crawler que consume el feed no puede mandar headers personalizados.

- [ ] **Step 1: Escribir el test del servicio**

Crear `apps/api/src/services/listing-feed.service.test.ts`. Patrón del repo: tenant
ids quemados, `prisma.tenant.upsert` en `beforeEach`, limpieza acotada a esos
tenants, Prisma real (nunca `vi.mock`).

```ts
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
});
```

Si algún campo obligatorio de `Unit`/`ListingPhoto` falta en `seedListing` y Prisma
se queja, agrégalo con un valor razonable — no cambies el schema para acomodar el
test.

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/listing-feed.service.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el servicio**

Crear `apps/api/src/services/listing-feed.service.ts`:

```ts
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
```

Nota: la query filtra `isActive: true`, así que `buildListingFeed` nunca verá inactivas por esta vía. El criterio vive igual en la función pura porque es parte de su contrato y está cubierto por sus propios tests — no lo quites de ahí.

- [ ] **Step 4: Correr los tests del servicio**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/listing-feed.service.test.ts`
Expected: PASS — los 5 tests.

- [ ] **Step 5: Agregar la ruta pública**

En `apps/api/src/routes/leads.ts`, junto a las otras rutas del `publicRouter`:

```ts
// Fase 4.1: feed de sindicación de listados. Lo consume un crawler de un
// portal (Meta, RentLinx, ListHub), que hace un GET plano y no puede mandar
// headers personalizados — por eso el tenant va en la query y no en
// `x-tenant-id` como el resto de las rutas públicas.
//
// Sin token a propósito: expone exactamente los mismos datos que
// `GET /public/units?tenant=`, que ya es público. Los listados de renta son
// públicos por definición; un token acá sería teatro de seguridad.
publicRouter.get('/listing-feed', async (req, res, next) => {
  try {
    const tenantId = req.query.tenant;
    if (typeof tenantId !== 'string' || tenantId === '') {
      res.status(400).json({ error: 'tenant query parameter is required' });
      return;
    }
    const { csv } = await getListingFeed(tenantId, new Date());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="listings.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
```

Agregar el import de `getListingFeed` junto a los otros imports de servicios del archivo.

- [ ] **Step 6: Escribir el test de wiring**

Agregar a `apps/api/src/routes/leads.test.ts`, usando el `routeSource` de scope de describe que ya usa el archivo:

```ts
describe('feed de sindicación', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'leads.ts'), 'utf8');

  it('la ruta lee el tenant de la query, no del header', () => {
    const idx = routeSource.indexOf("'/listing-feed'");
    expect(idx).toBeGreaterThan(-1);
    const handler = routeSource.slice(idx, idx + 1200);
    expect(handler).toContain('req.query.tenant');
    expect(handler).not.toContain("x-tenant-id");
  });

  it('la ruta responde text/csv y delega en getListingFeed', () => {
    const idx = routeSource.indexOf("'/listing-feed'");
    const handler = routeSource.slice(idx, idx + 1200);
    expect(handler).toContain('getListingFeed(tenantId, new Date())');
    expect(handler).toContain("'text/csv; charset=utf-8'");
  });

  // Es una ruta pública a propósito, pero no debe colgarse del router
  // autenticado por accidente.
  it('la ruta vive en publicRouter, no en leadsRouter', () => {
    expect(routeSource).toContain("publicRouter.get('/listing-feed'");
  });
});
```

- [ ] **Step 7: Correr la suite completa del API**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — 764 tests (756 baseline + 5 del servicio + 3 de wiring), o más si Task 1 ya sumó los suyos.

- [ ] **Step 8: Verificar typecheck**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin salida, exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/listing-feed.service.ts apps/api/src/services/listing-feed.service.test.ts apps/api/src/routes/leads.ts apps/api/src/routes/leads.test.ts
git commit -m "feat: ruta publica del feed de sindicacion de listados"
```

---

### Task 4: Visibilidad de listados no sindicados

**Files:**
- Modify: `apps/api/src/routes/properties.ts` (nueva ruta autenticada)
- Modify: `apps/api/src/routes/properties.test.ts`
- Modify: `apps/web/src/pages/PropertiesPage.tsx`

**Interfaces:**
- Consumes: `getListingFeed` de Task 3.
- Produces: `GET /properties/syndication-status` (autenticada) → `{ syndicated: number; skipped: SkippedListing[]; feedUrl: string }`.

**Contexto que el implementador no puede adivinar:** sin esto la omisión es silenciosa y el PM cree que sindica más de lo que sindica — que es justo el modo de falla que el diseño buscaba evitar, así que esta tarea no es cosmética. Las rutas de `properties.ts` usan `requireAuth` y sacan el tenant de `requireUser(req).tenantId` (el campo se llama `userId`/`tenantId`, no `id`). `PropertiesPage.tsx` usa `useQuery` de `@tanstack/react-query` con `apiFetch`; sigue el patrón de las queries que ya tiene.

- [ ] **Step 1: Escribir el test de la ruta**

La ruta delega en `getListingFeed`, que ya tiene sus propios tests de integración
(Task 3). Lo que falta cubrir acá es **la lógica propia de la ruta**: el conteo
derivado del CSV y la construcción de la `feedUrl`. Extráela a una función pura
exportada desde `properties.ts` para poder testearla sin `supertest`:

```ts
/** Filas del CSV menos el encabezado. Un feed vacío trae solo esa línea. */
export function countSyndicatedRows(csv: string): number {
  const trimmed = csv.trim();
  if (trimmed === '') return 0;
  return Math.max(0, trimmed.split('\n').length - 1);
}
```

Agregar a `apps/api/src/routes/properties.test.ts`:

```ts
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
```

Y un test de integración del extremo a extremo del conteo, reusando el patrón de
`listing-feed.service.test.ts` (tenant quemado, `prisma.tenant.upsert`, limpieza):

```ts
const TENANT_SYND_STATUS = 'tenant_test_syndication_status';

describe('estado de sindicación', () => {
  // beforeEach/afterEach: upsert del tenant y limpieza de listingPhoto,
  // unit y property de ese tenantId — igual que listing-feed.service.test.ts.

  it('cuenta solo las sindicables y detalla las omitidas', async () => {
    // Sembrar en TENANT_SYND_STATUS dos unidades: una completa y otra cuya
    // propiedad tiene yearBuilt: null.
    const { csv, skipped } = await getListingFeed(TENANT_SYND_STATUS, new Date());
    expect(countSyndicatedRows(csv)).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('missing_year_built');
  });
});
```

Escribe el sembrado con `prisma.property.create` / `prisma.unit.create` /
`prisma.listingPhoto.create` igual que el helper `seedListing` de Task 3 (puedes
copiarlo; son archivos distintos y el repo no comparte helpers de test entre
ellos).

- [ ] **Step 2: Correr para verificar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/routes/properties.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar la ruta**

En `apps/api/src/routes/properties.ts`:

```ts
// Fase 4.1: qué está y qué no está entrando al feed de sindicación. Sin
// esto la omisión es silenciosa y el PM cree que sindica más de lo que
// sindica.
propertiesRouter.get('/syndication-status', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { csv, skipped } = await getListingFeed(user.tenantId, new Date());
    const syndicated = countSyndicatedRows(csv);
    const base = getEnv().WEB_URL.replace(/\/+$/, '');
    res.json({
      syndicated,
      skipped,
      feedUrl: `${base}/api/public/listing-feed?tenant=${encodeURIComponent(user.tenantId)}`,
    });
  } catch (err) {
    next(err);
  }
});
```

**Ojo con el orden de las rutas en Express:** esta ruta es estática y debe declararse **antes** de cualquier `propertiesRouter.get('/:propertyId', ...)` que exista, o Express tomará `syndication-status` como un `propertyId`. Verifica si existe una ruta con parámetro y colócala arriba si es el caso.

Agrega los imports que falten (`getListingFeed`, `getEnv`).

- [ ] **Step 4: Correr los tests**

Run: `pnpm --filter @property-manager/api exec vitest run src/routes/properties.test.ts`
Expected: PASS.

- [ ] **Step 5: Mostrarlo en la UI**

En `apps/web/src/pages/PropertiesPage.tsx`, agregar una query y un bloque que:
- Muestre la URL del feed, con un botón de copiar, y una línea que explique para qué sirve (pegarla en el portal de sindicación).
- Muestre `syndicated` como "N listings in the feed".
- Si `skipped.length > 0`, liste cada uno con el nombre de la propiedad, el de la unidad y qué le falta, en texto accionable en inglés (la UI del producto es en inglés):
  - `missing_year_built` → "add the year built"
  - `missing_coordinates` → "add latitude and longitude"
  - `missing_photos` → "add at least one photo"
- Si no hay omitidos, no muestres una alerta vacía.

- [ ] **Step 6: Verificar typechecks**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Run: `pnpm --filter @property-manager/web exec tsc --noEmit`
Expected: sin salida, exit 0 en ambos.

- [ ] **Step 7: Correr la suite completa del monorepo**

Run: `pnpm -w test`
Expected: todos los paquetes en verde.

- [ ] **Step 8: Actualizar el roadmap**

En `docs/PRODUCT_ROADMAP.md`, en la sección de Fase 4.1, marcar lo entregado y dejar constancia de lo que sigue bloqueado. Incluye: que el feed existe y en qué URL; que publicar gratis en Marketplace requiere el Marketplace Partner Program (aprobación restringida, sin API pública); y que el catálogo de bienes raíces sirve para anuncios pagados y necesita Business Manager del usuario.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/properties.ts apps/api/src/routes/properties.test.ts apps/web/src/pages/PropertiesPage.tsx docs/PRODUCT_ROADMAP.md
git commit -m "feat: mostrar estado de sindicacion y url del feed"
```

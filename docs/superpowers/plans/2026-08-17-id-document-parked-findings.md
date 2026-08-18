# Cerrar hallazgos parqueados de la descarga del documento de identificación — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cerrar los tres hallazgos que la revisión final del branch de descarga del documento de identificación dejó parqueados: el `accept` desalineado del formulario público, la falta de traza de auditoría al descargar PII, y el guard anti path-traversal triplicado.

**Architecture:** tres tareas independientes entre sí. La Tarea 1 mueve la allowlist de mime types a `packages/core` (fuente única para API y web) y realinea el formulario público. La Tarea 2 agrega `writeAudit` a las dos rutas de descarga. La Tarea 3 extrae y endurece el guard de path traversal en un helper compartido. Ninguna depende del resultado de otra, pero las tres tocan `rental-application.service.ts`, así que deben ejecutarse en secuencia, no en paralelo.

**Tech Stack:** TypeScript, Node 24, Express, Prisma, Vitest, React 18 + Vite, pnpm workspaces.

## Global Constraints

- La validación del servidor **nunca se relaja**: la validación en cliente es solo UX. Un cliente no es un control de seguridad.
- El payload de auditoría **nunca** debe contener el contenido del documento, el base64, ni la storage key completa — solo identificadores.
- Un fallo de `writeAudit` **nunca** debe romper una descarga que ya funcionó (precedente: `owner-statement.service.ts:267`).
- `entityType` en entradas de auditoría va en snake_case minúsculas (`rental_application`), siguiendo la convención existente del repo.
- Toda lectura de archivo por `applicationId` sigue aislando por `tenantId` ANTES de tocar disco. Ninguna tarea puede debilitar ese orden.
- Los códigos de estado y mensajes de error existentes no cambian en ninguna tarea (son refactors de comportamiento idéntico, salvo el endurecimiento explícito de la comparación en Tarea 3).
- No se amplía la allowlist de mime types. Sigue siendo exactamente: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
- Correr `pnpm --filter @property-manager/api exec tsc --noEmit` y `pnpm --filter @property-manager/web exec tsc --noEmit` antes de cada commit; ambos deben salir limpios.

---

### Task 1: Allowlist compartida de mime types y realineación del formulario público

**Files:**
- Create: `packages/core/src/id-document.ts`
- Create: `packages/core/src/id-document.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json` (mapa `exports`)
- Modify: `apps/api/src/services/rental-application.service.ts:196-201`
- Modify: `apps/web/src/pages/ApplyPage.tsx:34-60,143`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: `ALLOWED_ID_DOCUMENT_MIME_TYPES: readonly string[]` e `isAllowedIdDocumentMimeType(value: string | null | undefined): boolean`, exportados desde `@property-manager/core/id-document` y también desde la raíz `@property-manager/core`.

**Contexto que el implementador no puede adivinar:** hoy la allowlist es un `Set` privado en `apps/api/src/services/rental-application.service.ts:196`, usado en dos lugares de ese archivo (línea 281 al recibir, línea 410 al servir). El formulario público `apps/web/src/pages/ApplyPage.tsx:143` tiene `accept="image/*,application/pdf"`, que ya no coincide — ese es el bug que esta tarea cierra. `apps/web` ya depende de `@property-manager/core` (ver `apps/web/package.json:15`) y ya lo importa por subpath (ver `ConversationsPage.tsx:7`).

- [ ] **Step 1: Escribir el test que falla**

Crear `packages/core/src/id-document.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ID_DOCUMENT_MIME_TYPES,
  isAllowedIdDocumentMimeType,
} from './id-document.js';

describe('ALLOWED_ID_DOCUMENT_MIME_TYPES', () => {
  it('contiene exactamente los cuatro tipos permitidos', () => {
    expect([...ALLOWED_ID_DOCUMENT_MIME_TYPES].sort()).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});

describe('isAllowedIdDocumentMimeType', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])(
    'acepta %s',
    (mime) => {
      expect(isAllowedIdDocumentMimeType(mime)).toBe(true);
    },
  );

  // Los dos vectores reales del hallazgo Critical que este allowlist cierra.
  it.each(['text/html', 'image/svg+xml'])('rechaza %s', (mime) => {
    expect(isAllowedIdDocumentMimeType(mime)).toBe(false);
  });

  // HEIC es el formato por defecto de iPhone: queda fuera por decisión
  // explícita del spec (Chrome/Firefox en Windows no lo muestran).
  it('rechaza image/heic', () => {
    expect(isAllowedIdDocumentMimeType('image/heic')).toBe(false);
  });

  it('rechaza null y undefined sin lanzar', () => {
    expect(isAllowedIdDocumentMimeType(null)).toBe(false);
    expect(isAllowedIdDocumentMimeType(undefined)).toBe(false);
  });

  // Match exacto: un parámetro extra no debe colarse.
  it('rechaza un tipo con parámetros extra', () => {
    expect(isAllowedIdDocumentMimeType('image/png; charset=x')).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `pnpm --filter @property-manager/core exec vitest run src/id-document.test.ts`
Expected: FAIL — "Failed to resolve import './id-document.js'"

- [ ] **Step 3: Crear el módulo compartido**

Crear `packages/core/src/id-document.ts`:

```ts
/**
 * Allowlist de tipos MIME aceptados para el documento de identificación de
 * una solicitud de renta.
 *
 * Vive en `core` (y no en el servicio del API) porque la necesitan los DOS
 * lados: el API para validar al recibir y al servir, y el formulario público
 * (`apps/web/src/pages/ApplyPage.tsx`) para el `accept` del input y para
 * avisar al solicitante antes de subir. Cuando estaban duplicadas, el fix de
 * seguridad que estrechó la del servidor dejó el `accept` del formulario
 * ofreciendo tipos que el servidor ya rechazaba — un solicitante subía una
 * foto HEIC de iPhone y recibía un error que no podía accionar.
 *
 * Origen de la allowlist (hallazgo Critical, XSS almacenado): el mime type lo
 * manda el solicitante sin autenticar y se sirve como `Content-Type` en la
 * descarga. Sin allowlist, `text/html` o `image/svg+xml` ejecutan script en el
 * origen del SPA cuando el staff abre el documento. NO agregar tipos que un
 * navegador pueda interpretar como documento activo.
 */
export const ALLOWED_ID_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const satisfies readonly string[];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_ID_DOCUMENT_MIME_TYPES);

/**
 * Match exacto contra la allowlist. Acepta `null`/`undefined` sin lanzar
 * porque los call sites reciben valores tanto de la BD (columna nullable en
 * filas legacy) como del navegador (`File.type` puede venir vacío).
 */
export function isAllowedIdDocumentMimeType(value: string | null | undefined): boolean {
  return typeof value === 'string' && ALLOWED_SET.has(value);
}
```

- [ ] **Step 4: Exportar el módulo desde el paquete**

En `packages/core/src/index.ts`, agregar al final de la lista de re-exports:

```ts
export * from './id-document.js';
```

En `packages/core/package.json`, agregar la entrada al mapa `exports` (queda junto a las otras tres entradas de subpath ya existentes):

```json
    "./id-document": "./src/id-document.ts"
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `pnpm --filter @property-manager/core exec vitest run src/id-document.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Consumir la constante compartida desde el API**

En `apps/api/src/services/rental-application.service.ts`, borrar la declaración local del `Set` (líneas 196-201, el bloque `const ALLOWED_ID_DOCUMENT_MIME_TYPES = new Set([...])`) **conservando el comentario largo que lo precede** (líneas 185-195) — ese comentario explica el hallazgo Critical y sigue siendo válido; solo agregarle una línea final que diga que la lista ahora vive en `@property-manager/core/id-document`.

Agregar el import junto a los otros imports de `@property-manager/core` que ya existen en el archivo:

```ts
import { isAllowedIdDocumentMimeType } from '@property-manager/core';
```

Reemplazar el uso en el lado de recepción (línea ~281):

```ts
  if (!isAllowedIdDocumentMimeType(input.idDocumentMimeType)) {
```

Reemplazar el uso en el lado de servido (línea ~410):

```ts
  const contentType = isAllowedIdDocumentMimeType(application.idDocumentMimeType)
    ? application.idDocumentMimeType
    : 'application/octet-stream';
```

**Ojo con TypeScript:** `isAllowedIdDocumentMimeType` no es un type guard, así que en la rama verdadera `application.idDocumentMimeType` sigue siendo `string | null` para el compilador. Si `tsc` se queja, la solución correcta es declarar el retorno como type predicate en `id-document.ts` (`value is string`), no un `as string` en el call site.

- [ ] **Step 7: Correr los tests del API para verificar que nada se rompió**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: PASS — 48 tests, incluidos los del hallazgo Critical (`rejects an idDocumentMimeType outside the allowlist`, `never serves a poisoned legacy Content-Type`). Si alguno de esos dos falla, la refactorización rompió el fix de seguridad: NO seguir, arreglarlo.

- [ ] **Step 8: Realinear el formulario público**

En `apps/web/src/pages/ApplyPage.tsx`, agregar el import:

```ts
import { ALLOWED_ID_DOCUMENT_MIME_TYPES, isAllowedIdDocumentMimeType } from '@property-manager/core/id-document';
```

Agregar debajo de la constante `MAX_ID_DOCUMENT_MB` ya existente (línea ~28):

```ts
// Derivado de la allowlist compartida, no una cadena literal: cuando estaban
// duplicadas, el `accept` quedó ofreciendo tipos que el servidor rechazaba.
const ID_DOCUMENT_ACCEPT = ALLOWED_ID_DOCUMENT_MIME_TYPES.join(',');
const ID_DOCUMENT_FORMATS_LABEL = 'JPEG, PNG, WebP or PDF';
```

Reemplazar el `accept` del input (línea ~143):

```tsx
            accept={ID_DOCUMENT_ACCEPT}
```

Agregar la validación de tipo en `handleIdFileChange`, **antes** de la validación de tamaño que ya existe (así el solicitante ve primero el problema que le impide continuar del todo):

```ts
  function handleIdFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    // `accept` es solo una sugerencia — arrastrar-y-soltar y algunos
    // selectores de Android lo ignoran. Esto es UX, no seguridad: el
    // servidor revalida con la misma allowlist compartida.
    if (file && !isAllowedIdDocumentMimeType(file.type)) {
      setError(
        `That file type isn't supported. Please upload your ID as ${ID_DOCUMENT_FORMATS_LABEL}. If you're on an iPhone, choosing the photo from your photo library converts it automatically.`,
      );
      setIdFile(null);
      event.target.value = '';
      return;
    }
    if (file && file.size > MAX_ID_DOCUMENT_BYTES) {
      setError(
        `That file is too large (max ~${MAX_ID_DOCUMENT_MB} MB). Try taking the photo at a lower resolution, or upload a smaller image.`,
      );
      setIdFile(null);
      event.target.value = '';
      return;
    }
    setError(null);
    setIdFile(file);
  }
```

- [ ] **Step 9: Verificar typecheck en ambos paquetes**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin salida, exit 0

Run: `pnpm --filter @property-manager/web exec tsc --noEmit`
Expected: sin salida, exit 0

Si `web` falla por no resolver `@property-manager/core/id-document`, revisar que la entrada del mapa `exports` del Step 4 esté escrita exactamente igual que las otras tres.

- [ ] **Step 10: Correr la suite completa del monorepo**

Run: `pnpm -w test`
Expected: todos los paquetes en verde. Baseline antes de esta tarea: api 748, core 79, adapters 85, web 2. Después de esta tarea core debe subir a 89 (10 tests nuevos).

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/id-document.ts packages/core/src/id-document.test.ts packages/core/src/index.ts packages/core/package.json apps/api/src/services/rental-application.service.ts apps/web/src/pages/ApplyPage.tsx
git commit -m "fix: realinear el accept del formulario con la allowlist del servidor"
```

---

### Task 2: Traza de auditoría en las descargas de PII

**Files:**
- Modify: `apps/api/src/routes/leads.ts:679-751` (las dos rutas de descarga)
- Test: `apps/api/src/routes/leads.test.ts`

**Interfaces:**
- Consumes: nada de la Tarea 1 (independiente).
- Produces: nada que consuman tareas posteriores.

**Contexto que el implementador no puede adivinar:** el repo tiene un audit trail encadenado y tamper-evident en `apps/api/src/services/audit.service.ts`. La firma es `writeAudit({ tenantId, actorId, actorType, action, entityType, entityId, payload })`. Existe un helper `actorFromUser(userId, role)` en ese mismo archivo que devuelve `{ actorId, actorType: 'user' }`. `requireUser(req)` devuelve un `AuthUser` cuyo campo de id se llama `userId` (NO `id`) — ver `apps/api/src/auth/context.ts:11-16`. Las dos rutas a modificar están en `leads.ts`: la de reportes de screening (línea ~679) y la del documento de identificación (línea ~731). `leads.test.ts` verifica el wiring de rutas por grep sobre el texto fuente, porque este repo no tiene `supertest` — es la convención establecida, no un atajo.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `apps/api/src/routes/leads.test.ts`, siguiendo el patrón de grep que ya usan las suites de ese archivo:

```ts
describe('audit trail en descargas de PII', () => {
  it('la ruta de documento de identificación escribe una entrada de auditoría', () => {
    const source = readFileSync(
      new URL('./leads.ts', import.meta.url),
      'utf8',
    );
    const routeIndex = source.indexOf("'/applications/:applicationId/id-document'");
    expect(routeIndex).toBeGreaterThan(-1);
    const handler = source.slice(routeIndex, routeIndex + 1600);
    expect(handler).toContain('writeAudit');
    expect(handler).toContain("action: 'rental_application.id_document.downloaded'");
    expect(handler).toContain("entityType: 'rental_application'");
    expect(handler).toContain('actorFromUser(user.userId, user.role)');
  });

  it('la ruta de reporte de screening escribe una entrada de auditoría con el kind', () => {
    const source = readFileSync(
      new URL('./leads.ts', import.meta.url),
      'utf8',
    );
    const routeIndex = source.indexOf("'/applications/:applicationId/report/:kind'");
    expect(routeIndex).toBeGreaterThan(-1);
    const handler = source.slice(routeIndex, routeIndex + 2000);
    expect(handler).toContain('writeAudit');
    expect(handler).toContain("action: 'rental_application.screening_report.downloaded'");
    expect(handler).toContain('payload: { kind }');
  });

  it('ninguna de las dos rutas mete el archivo ni la storage key en el payload de auditoría', () => {
    const source = readFileSync(
      new URL('./leads.ts', import.meta.url),
      'utf8',
    );
    // El payload de auditoría es consultable y persistente: meterle PII lo
    // convierte en una segunda copia de lo que se pretendía proteger.
    expect(source).not.toContain('payload: { file');
    expect(source).not.toContain('storageKey: key');
    expect(source).not.toContain('idDocumentBase64');
  });
});
```

Si `readFileSync` no está importado ya en ese archivo, agregar `import { readFileSync } from 'node:fs';` al inicio.

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `pnpm --filter @property-manager/api exec vitest run src/routes/leads.test.ts`
Expected: FAIL — los dos primeros tests fallan porque `writeAudit` no aparece en ninguno de los dos handlers. El tercero pasa desde el inicio (es un guard de regresión).

- [ ] **Step 3: Agregar el import en leads.ts**

En `apps/api/src/routes/leads.ts`, junto a los otros imports de servicios:

```ts
import { actorFromUser, writeAudit } from '../services/audit.service.js';
```

- [ ] **Step 4: Instrumentar la ruta del documento de identificación**

En el handler de `/applications/:applicationId/id-document`, insertar el bloque de auditoría **después** del `if (!result.ok)` (para no auditar los 404, que no son acceso a PII) y **antes** de los `setHeader`:

```ts
    // Acceso a PII: descargar la identificación gubernamental de un
    // solicitante queda trazado en el audit trail encadenado. Un fallo de
    // auditoría no rompe una descarga que ya funcionó — mismo criterio que
    // owner-statement.service.ts tras cerrar un mes. El payload lleva solo
    // identificadores: nunca el archivo ni la storage key.
    try {
      await writeAudit({
        tenantId: user.tenantId,
        ...actorFromUser(user.userId, user.role),
        action: 'rental_application.id_document.downloaded',
        entityType: 'rental_application',
        entityId: applicationId,
        payload: {},
      });
    } catch (auditError) {
      console.error('[leads] writeAudit failed after id-document download:', auditError);
    }
```

- [ ] **Step 5: Instrumentar la ruta del reporte de screening**

En el handler de `/applications/:applicationId/report/:kind`, insertar el mismo bloque **después** del `const file = await fs.readFile(target);` y **antes** de los `setHeader`:

```ts
    // Mismo criterio que la descarga del documento de identificación: el
    // reporte de crédito/antecedentes es PII sensible y su acceso queda
    // trazado. El payload lleva el tipo de reporte, nunca su contenido.
    try {
      await writeAudit({
        tenantId: user.tenantId,
        ...actorFromUser(user.userId, user.role),
        action: 'rental_application.screening_report.downloaded',
        entityType: 'rental_application',
        entityId: applicationId,
        payload: { kind },
      });
    } catch (auditError) {
      console.error('[leads] writeAudit failed after screening-report download:', auditError);
    }
```

- [ ] **Step 6: Correr los tests para verificar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/routes/leads.test.ts`
Expected: PASS — 24 tests (21 previos + 3 nuevos)

- [ ] **Step 7: Verificar typecheck**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin salida, exit 0

- [ ] **Step 8: Correr la suite completa del API**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — 751 tests (748 previos + 3 nuevos). El conteo de `api` no
cambia por la Tarea 1: sus tests nuevos viven en `packages/core`, no acá.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/leads.ts apps/api/src/routes/leads.test.ts
git commit -m "feat: trazar en el audit trail las descargas de PII de solicitudes"
```

---

### Task 3: Guard anti path-traversal compartido y endurecido

**Files:**
- Modify: `apps/api/src/services/document-storage.service.ts:32-54`
- Modify: `apps/api/src/services/rental-application.service.ts:396-403`
- Modify: `apps/api/src/routes/leads.ts:706-715`
- Test: `apps/api/src/services/document-storage.service.test.ts`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: `resolveStorageKeyWithinRoot(rootDir: string, key: string): string | null` exportado desde `apps/api/src/services/document-storage.service.ts`. Devuelve la ruta absoluta resuelta, o `null` si la key escapa del root.

**Contexto que el implementador no puede adivinar:** el mismo guard (`path.resolve` + `startsWith(root)`) está copiado en tres lugares: `document-storage.service.ts:38-40` (al escribir), `leads.ts:707-712` (descarga de reportes) y `rental-application.service.ts:397-401` (descarga de ID). La comparación `target.startsWith(root)` sin exigir separador es un falso negativo clásico: `/data/docs-evil` pasa el guard de `/data/docs`. **Hoy no es explotable** — todas las keys las genera `buildDocumentStorageKey` con segmentos saneados y ninguna ruta acepta una key cruda del request — pero es una trampa para la primera ruta que sí lo haga. Cada call site conserva su propio manejo de error: `putObject` lanza `Error`, `getIdDocumentForDownload` devuelve `{ ok: false, status: 400, error: 'Invalid document path' }`, y la ruta de reportes responde `400 'Invalid report path'`. Esos mensajes y códigos NO cambian.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `apps/api/src/services/document-storage.service.test.ts`:

```ts
describe('resolveStorageKeyWithinRoot', () => {
  it('resuelve una key normal dentro del root', () => {
    const resolved = resolveStorageKeyWithinRoot('/data/docs', 'tenants/t1/documents/d1/file.pdf');
    expect(resolved).toBe(path.resolve('/data/docs', 'tenants/t1/documents/d1/file.pdf'));
  });

  it('rechaza una key que escapa con ..', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '../../etc/passwd')).toBeNull();
  });

  it('rechaza una key absoluta que apunta fuera del root', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '/etc/passwd')).toBeNull();
  });

  // El caso que la comparación vieja (startsWith sin separador) dejaba pasar:
  // un directorio hermano cuyo nombre empieza igual que el root.
  it('rechaza un directorio hermano con el mismo prefijo (docs-evil vs docs)', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '../docs-evil/file.pdf')).toBeNull();
  });

  it('acepta el root mismo', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '.')).toBe(path.resolve('/data/docs'));
  });
});
```

Si `path` no está importado en ese archivo de test, agregar `import path from 'node:path';`. Importar también `resolveStorageKeyWithinRoot` desde `./document-storage.service.js` junto a lo que el archivo ya importe.

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/document-storage.service.test.ts`
Expected: FAIL — "resolveStorageKeyWithinRoot is not a function" o error de import.

- [ ] **Step 3: Escribir el helper compartido**

En `apps/api/src/services/document-storage.service.ts`, agregar antes de `createLocalDocumentStorage`:

```ts
/**
 * Resuelve una storage key contra el root configurado, devolviendo `null` si
 * la ruta resultante escapa de ese root.
 *
 * Fuente única del guard anti path-traversal: antes estaba copiado en tres
 * lugares (escritura acá, descarga de reportes en routes/leads.ts, descarga
 * del documento de identificación en rental-application.service.ts), lo que
 * obligaba a endurecer tres sitios a la vez y era fácil olvidar uno.
 *
 * La comparación exige el separador (`root + path.sep`) en vez de un
 * `startsWith(root)` pelón: sin él, un directorio hermano cuyo nombre empieza
 * igual que el root (`/data/docs-evil` contra `/data/docs`) pasaba el guard.
 * Hoy no es explotable porque todas las keys las genera
 * `buildDocumentStorageKey` con segmentos saneados y ninguna ruta acepta una
 * key cruda del request — pero es la trampa que espera a la primera que sí.
 */
export function resolveStorageKeyWithinRoot(rootDir: string, key: string): string | null {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }
  return target;
}
```

- [ ] **Step 4: Usar el helper en el call site de escritura**

Reemplazar el cuerpo del guard dentro de `putObject` (líneas 38-42), conservando el mismo mensaje de error:

```ts
      const target = resolveStorageKeyWithinRoot(input.rootDir, object.key);
      if (target === null) {
        throw new Error('Document storage key escaped the configured root directory');
      }
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/document-storage.service.test.ts`
Expected: PASS — los 5 tests nuevos más los que el archivo ya tenía.

- [ ] **Step 6: Usar el helper en la descarga del documento de identificación**

En `apps/api/src/services/rental-application.service.ts`, reemplazar el bloque del guard (líneas ~396-403). Agregar `resolveStorageKeyWithinRoot` al import que ya existe de `./document-storage.service.js`:

```ts
  const env = getEnv();
  const target = resolveStorageKeyWithinRoot(env.DOCUMENT_STORAGE_DIR, application.idDocumentStorageKey);
  if (target === null) {
    return { ok: false, status: 400, error: 'Invalid document path' };
  }
  const file = await fs.readFile(target);
```

Si tras esto `path` queda sin uso en el archivo, quitar su import; si sigue usándose en otro lado, dejarlo.

- [ ] **Step 7: Usar el helper en la descarga del reporte de screening**

En `apps/api/src/routes/leads.ts`, reemplazar el bloque del guard (líneas ~706-715), conservando el mensaje `'Invalid report path'`. Agregar `resolveStorageKeyWithinRoot` al import de `document-storage.service.js` si ya existe uno; si no, crearlo:

```ts
    const env = getEnv();
    const target = resolveStorageKeyWithinRoot(env.DOCUMENT_STORAGE_DIR, key);
    if (target === null) {
      res.status(400).json({ error: 'Invalid report path' });
      return;
    }
    const file = await fs.readFile(target);
```

- [ ] **Step 8: Verificar que el test de path traversal existente sigue pasando**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: PASS — 48 tests. Prestar atención específica al test que fuerza `idDocumentStorageKey: '../../etc/passwd'` y espera `{ ok: false, status: 400, error: 'Invalid document path' }`: si ese falla, el refactor cambió comportamiento y hay que corregirlo, no ajustar el test.

- [ ] **Step 9: Verificar typecheck**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin salida, exit 0

- [ ] **Step 10: Correr la suite completa del monorepo**

Run: `pnpm -w test`
Expected: todos los paquetes en verde, con los tests nuevos de las tres tareas sumados.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/document-storage.service.ts apps/api/src/services/document-storage.service.test.ts apps/api/src/services/rental-application.service.ts apps/api/src/routes/leads.ts
git commit -m "refactor: unificar y endurecer el guard anti path-traversal"
```

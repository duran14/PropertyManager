# ID Document Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar de descartar el mime type del documento de identificación subido en la solicitud pública de renta, y agregar una ruta de descarga autenticada para que el staff pueda verlo — cierra un gap señalado varias veces en el código desde la Fase 2A.

**Architecture:** Replica el patrón ya probado de la ruta de descarga de reportes de screening (`GET /leads/applications/:applicationId/report/:kind`): aislamiento por tenant, guard anti path-traversal, descarga autenticada por fetch+blob en el frontend (el token vive en memoria, no en cookie).

**Tech Stack:** Prisma, Express, React + TanStack Query — sin dependencias nuevas.

## Global Constraints

- La ruta nueva usa `requireAuth` sin restricción de rol adicional — mismo nivel de acceso que la ruta de reportes de screening ya existente, sin motivo para tratarlo distinto.
- Aislamiento por tenant: la fila se busca filtrada por `tenantId` del usuario autenticado ANTES de tocar el disco.
- Mismo guard anti path-traversal que ya usa la ruta de reportes (`target.startsWith(root)`), copiado literal — es un punto de lectura independiente, no una llamada al servicio de escritura.
- Filas existentes (subidas antes de esta migración) no tienen `idDocumentMimeType` — deben seguir siendo descargables con un fallback `application/octet-stream`, no romperse.
- Si algo falla (test rojo, tsc), reporta BLOCKED — no commitees en rojo.

---

### Task 1: Persistir `idDocumentMimeType`

**Files:**
- Modify: `apps/api/prisma/schema.prisma:903` (modelo `RentalApplication`)
- Modify: `apps/api/src/services/rental-application.service.ts:304` (el `updateMany` de `submitRentalApplication`)
- Test: `apps/api/src/services/rental-application.service.test.ts`

**Interfaces:**
- Produces: columna `idDocumentMimeType String?` en `RentalApplication`, poblada por `submitRentalApplication` a partir de `input.idDocumentMimeType` (ya existe en el tipo `SubmitApplicationInput`, ya se manda desde `ApplyPage.tsx:84` — nadie más necesita cambiar para que este dato empiece a fluir). Consumida por la Tarea 2 (la ruta de descarga).

- [ ] **Step 1: Agregar la columna al schema**

En `apps/api/prisma/schema.prisma`, dentro del modelo `RentalApplication`, junto a la línea `idDocumentStorageKey String?` (línea 903):

```prisma
  idDocumentStorageKey String?
  // El frontend público ya manda este dato (ApplyPage.tsx) desde la Fase
  // 2A, pero nunca se persistía — sin él, una ruta de descarga no puede
  // servir el archivo con el Content-Type correcto (el documento puede
  // ser JPG, PNG o PDF).
  idDocumentMimeType   String?
```

- [ ] **Step 2: Migrar**

```bash
pnpm --filter @property-manager/api exec prisma migrate dev --name add_id_document_mime_type
```

Expected: migración nueva en `apps/api/prisma/migrations/`, aditiva (una sola columna `ADD COLUMN`, sin `DROP`), aplica limpio.

- [ ] **Step 3: Escribir el test que falla**

En `apps/api/src/services/rental-application.service.test.ts`, buscar el describe block de `submitRentalApplication` (mismo que ya valida `idDocumentStorageKey`) y agregar:

```ts
it('persiste idDocumentMimeType junto con idDocumentStorageKey', async () => {
  const { token } = await seedInvitedApplication();
  const result = await submitRentalApplication(
    token,
    validSubmission({ idDocumentMimeType: 'image/png' }),
    deps,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: result.applicationId } });
  expect(row.idDocumentMimeType).toBe('image/png');
});
```

(Revisa el helper `validSubmission()` ya existente en este archivo — probablemente ya manda `idDocumentMimeType: 'image/jpeg'` como parte de sus defaults, dado que el campo ya es requerido en `submitRentalApplication`'s validación actual; en ese caso el `overrides` de arriba solo confirma que el override también se persiste.)

- [ ] **Step 4: Correr y verificar que falla**

```bash
pnpm --filter @property-manager/api exec vitest run rental-application.service.test.ts
```

Expected: FAIL — `idDocumentMimeType` no se persiste todavía (columna existe desde el Step 2, pero el `updateMany` no la escribe).

- [ ] **Step 5: Persistir el campo**

En `apps/api/src/services/rental-application.service.ts`, línea 304, reemplazar:

```ts
      idDocumentStorageKey,
```

por:

```ts
      idDocumentStorageKey,
      idDocumentMimeType: input.idDocumentMimeType,
```

- [ ] **Step 6: Correr y verificar que pasa**

```bash
pnpm --filter @property-manager/api exec vitest run rental-application.service.test.ts
```

Expected: PASS — todos los tests de este archivo, incluido el nuevo.

- [ ] **Step 7: Verificar compilación**

```bash
pnpm --filter @property-manager/api exec tsc --noEmit
```

Expected: sin errores.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts
git commit -m "feat: persistir el mime type del documento de identificación"
```

---

### Task 2: Ruta de descarga + botón en Showings

**Files:**
- Modify: `apps/api/src/routes/leads.ts` (ruta nueva, junto a la de reportes de screening en la línea 678)
- Modify: `apps/api/src/routes/showings.ts:129` (agregar `idDocumentMimeType` al `select` de `GET /:id/application`)
- Modify: `apps/web/src/pages/ShowingsPage.tsx` (tipo `ApplicationDetail`, botón de descarga)
- Test: `apps/api/src/routes/leads.test.ts`

**Interfaces:**
- Consumes: columna `idDocumentMimeType` (Tarea 1).
- Produces: `GET /leads/applications/:applicationId/id-document` — `requireAuth`, 404 si la aplicación no existe para el tenant del usuario o si `idDocumentStorageKey` es null, 200 sirviendo el archivo con `Content-Type` de `idDocumentMimeType` (fallback `application/octet-stream` si es null).

- [ ] **Step 1: Ruta de descarga en `leads.ts`**

Junto a la ruta existente `GET /applications/:applicationId/report/:kind` (línea 678), agregar:

```ts
// Mismo patrón que la ruta de reportes de screening de arriba, para el
// documento de identificación subido en el formulario público (Fase 2A) —
// existía el archivo guardado pero nunca una ruta que lo sirviera.
leadsRouter.get('/applications/:applicationId/id-document', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { applicationId } = req.params;
    // Aislamiento por tenant: la fila se busca filtrada por el tenantId del
    // usuario autenticado ANTES de tocar el disco — mismo razonamiento que
    // la ruta de reportes.
    const application = await prisma.rentalApplication.findFirst({
      where: { id: applicationId, tenantId: user.tenantId },
      select: { idDocumentStorageKey: true, idDocumentMimeType: true },
    });
    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    if (!application.idDocumentStorageKey) {
      res.status(404).json({ error: 'ID document not available' });
      return;
    }

    const env = getEnv();
    const root = path.resolve(env.DOCUMENT_STORAGE_DIR);
    const target = path.resolve(root, application.idDocumentStorageKey);
    // Mismo guard de path traversal que ya usa createLocalDocumentStorage
    // al escribir y la ruta de reportes al leer.
    if (!target.startsWith(root)) {
      res.status(400).json({ error: 'Invalid document path' });
      return;
    }
    const file = await fs.readFile(target);
    res.setHeader('Content-Type', application.idDocumentMimeType ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="id-document"');
    res.send(file);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Test de la ruta**

En `apps/api/src/routes/leads.test.ts`, sigue el patrón de test ya usado para la ruta de reportes de screening en el mismo archivo (búscalo — mismo estilo de request HTTP real, seed de una `RentalApplication` con `idDocumentStorageKey`/`idDocumentMimeType` reales apuntando a un archivo de prueba en disco). Agrega:

```ts
it('GET /applications/:id/id-document sirve el archivo con el Content-Type correcto', async () => {
  // seed de una RentalApplication con idDocumentStorageKey apuntando a un
  // archivo real escrito en DOCUMENT_STORAGE_DIR e idDocumentMimeType
  // 'image/png' — sigue el mismo patrón de setup que el test existente de
  // GET /applications/:id/report/:kind en este archivo.
  const res = await request(app)
    .get(`/leads/applications/${applicationId}/id-document`)
    .set('Authorization', `Bearer ${accessToken}`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('image/png');
});

it('GET /applications/:id/id-document devuelve 404 si no hay documento', async () => {
  // seed de una RentalApplication SIN idDocumentStorageKey
  const res = await request(app)
    .get(`/leads/applications/${applicationOtroId}/id-document`)
    .set('Authorization', `Bearer ${accessToken}`);
  expect(res.status).toBe(404);
});

it('GET /applications/:id/id-document devuelve 404 para un applicationId de otro tenant', async () => {
  const res = await request(app)
    .get(`/leads/applications/${applicationDeOtroTenantId}/id-document`)
    .set('Authorization', `Bearer ${accessToken}`);
  expect(res.status).toBe(404);
});
```

(Este archivo probablemente NO usa `supertest` — revisa el patrón real ya usado para tests de rutas en este mismo archivo, tal como ya se confirmó en una fase anterior de este proyecto: si no hay infraestructura de supertest, sigue el patrón de verificación por grep del wiring de middleware ya establecido, y cubre la lógica de negocio directamente si existe una función de servicio separable — si la lógica de esta ruta es simple y vive toda inline en el handler, considera extraer el cuerpo a una función `getIdDocumentForDownload(applicationId, tenantId)` en `rental-application.service.ts` que SÍ se pueda testear directo, igual que el resto de funciones de ese archivo, y que la ruta solo llame.)

- [ ] **Step 3: Correr y verificar**

```bash
pnpm --filter @property-manager/api exec vitest run leads.test.ts
```

Expected: PASS.

- [ ] **Step 4: `showings.ts` — agregar el campo al `select` existente**

En `apps/api/src/routes/showings.ts`, la ruta `GET /:id/application` (línea ~129) ya tiene un `select` explícito con `idDocumentStorageKey: true`. Agregar junto a esa línea:

```ts
        idDocumentMimeType: true,
```

- [ ] **Step 5: `ApplicationDetail` y botón de descarga en `ShowingsPage.tsx`**

En la interfaz `ApplicationDetail` (línea 31-54), agregar junto a `idDocumentStorageKey: string | null;`:

```ts
  idDocumentMimeType: string | null;
```

En `CompletedApplicationPanel` (línea 328-337), reemplazar el bloque que hoy solo muestra el texto:

```tsx
      {app.idDocumentStorageKey && (
        // Hay un documento de identificación guardado, pero no existe
        // ninguna ruta en la app que sirva archivos de DOCUMENT_STORAGE_DIR
        // — servir/descargar el documento queda fuera de alcance de este
        // fix y es trabajo futuro.
        <div className="flex items-center gap-1 text-slate-500">
          <Icon name="approve" size={12} className="text-green-600" />
          ID document attached
        </div>
      )}
```

por un componente nuevo `IdDocumentDownload`, agregado junto a `ScreeningBlock` (mismo archivo, antes de `CompletedApplicationPanel`), replicando el mecanismo de descarga autenticada ya usado ahí (fetch con `Authorization: Bearer`, blob URL, pestaña nueva — necesario porque el token vive en memoria, no en cookie, mismo razonamiento ya documentado en `ScreeningBlock.handleDownload`):

```tsx
function IdDocumentDownload({ applicationId }: { applicationId: string }) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  async function handleDownload() {
    setDownloadError(null);
    setIsDownloading(true);
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_BASE}/leads/applications/${applicationId}/id-document`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'include',
      });
      if (!res.ok) {
        setDownloadError('Could not download the document');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setDownloadError('Could not download the document');
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="flex items-center gap-1 text-slate-500">
      <Icon name="approve" size={12} className="text-green-600" />
      <button type="button" onClick={handleDownload} disabled={isDownloading} className="text-teal-600 hover:underline disabled:opacity-50">
        {isDownloading ? 'Opening document…' : 'ID document — download'}
      </button>
      {downloadError && <span className="ml-1 text-red-600">{downloadError}</span>}
    </div>
  );
}
```

Y en `CompletedApplicationPanel`, reemplazar el bloque condicional de arriba por:

```tsx
      {app.idDocumentStorageKey && <IdDocumentDownload applicationId={app.id} />}
```

- [ ] **Step 6: Verificar compilación y suite de `web`**

```bash
pnpm --filter @property-manager/web exec tsc --noEmit
pnpm --filter @property-manager/web test
```

Expected: sin errores; los 2 tests existentes de `web` en verde (no hay tests de componente para `ShowingsPage.tsx` hoy — consistente con la convención ya establecida en fases anteriores).

- [ ] **Step 7: Regresión completa del monorepo**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Expected: todo verde en los 4 paquetes. Si algo falla, no commitear: reportar BLOCKED.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/leads.ts apps/api/src/routes/leads.test.ts apps/api/src/routes/showings.ts apps/web/src/pages/ShowingsPage.tsx
git commit -m "feat: ruta de descarga del documento de identificación + botón en Showings"
```

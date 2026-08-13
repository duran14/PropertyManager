# Manual Report Upload (Fase 2.2 nivel 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el staff pueda subir un reporte de crédito o antecedentes penales en PDF (de cualquier proveedor, obtenido por fuera de esta app) y el sistema extraiga veredicto + resumen vía visión/OCR (GLM), sin depender de qué proveedor de antecedentes penales se elija.

**Architecture:** Un método nuevo en `GlmAdapter` (deliberadamente agnóstico de proveedor — no reutiliza `extractCreditReport`, atado al layout de FrontLobby), una función de servicio nueva que escribe directo a los campos ya existentes de `RentalApplication` (sin reutilizar el guard de `persistTerminalResult`, pensado para escrituras automáticas rezagadas, no para una acción humana explícita), una ruta autenticada, y un botón de carga en la UI ya existente de Showings.

**Tech Stack:** TypeScript, Vitest, React + TanStack Query — sin dependencias nuevas, sin migración de schema.

## Global Constraints

- Esta feature es independiente de qué proveedor de antecedentes penales se use — nunca asume FrontLobby ni ningún proveedor específico.
- La carga es una acción humana explícita — puede registrar un resultado sin importar el estado actual del checkeo (`awaiting_approval`, `failed`, vacío, o incluso sobreescribir un `passed`/`flagged` previo), a diferencia de las escrituras automáticas que sí respetan el guard de estado abierto.
- Si el modelo no puede determinar un veredicto confiable (`verdict: null`, o `confidence` bajo un umbral), la carga se rechaza con un error claro — nunca se inventa un `passed`/`flagged`.
- Todo veredicto que sale de esta carga se marca `[AUTOMATED]` en el summary — es una interpretación de IA del documento, no una lectura humana línea por línea.
- Aislamiento por tenant en toda lectura/escritura.
- Si algo falla (test rojo, tsc), reporta BLOCKED — no commitees en rojo.

---

### Task 1: `GlmAdapter.extractScreeningReport` — método genérico nuevo

**Files:**
- Modify: `packages/adapters/src/contracts.ts` (interfaz `GlmAdapter`, tipo nuevo `ScreeningReportExtraction`)
- Modify: `packages/adapters/src/mocks/glm.mock.ts`
- Modify: `packages/adapters/src/real/glm.real.ts`
- Test: `packages/adapters/src/mocks/glm.mock.test.ts` (ya existe, de una fase anterior — extenderlo)

**Interfaces:**
- Produces: `GlmAdapter.extractScreeningReport(input: {mimeType: string; base64: string; filename?: string; kind: 'credit' | 'criminal'}): Promise<ScreeningReportExtraction>`, con `ScreeningReportExtraction = {verdict: 'passed' | 'flagged' | null; summaryText: string; confidence: number}` — consumido por la Tarea 2.

- [ ] **Step 1: Tipo y contrato nuevos**

En `packages/adapters/src/contracts.ts`, buscar la interfaz `GlmAdapter` (tiene `reason`, `extractReceipt`, `extractCreditReport`) y, justo antes, agregar:

```ts
export interface ScreeningReportExtraction {
  /** null si el modelo no pudo determinar un veredicto del documento. */
  verdict: 'passed' | 'flagged' | null;
  /** Resumen en texto plano de lo que dice el reporte (2-4 oraciones). */
  summaryText: string;
  /** Confidence global de la extracción (0..1). */
  confidence: number;
}
```

Y dentro de `GlmAdapter`, agregar el método:

```ts
export interface GlmAdapter {
  readonly name: 'glm';
  reason(request: GlmReasoningRequest): Promise<GlmReasoningResponse>;
  extractReceipt(input: { mimeType: string; base64: string; filename?: string }): Promise<OcrResult>;
  extractCreditReport(input: { mimeType: string; base64: string; filename?: string }): Promise<CreditReportExtraction>;
  /** OCR/visión genérico de un reporte de screening (crédito o antecedentes), de CUALQUIER proveedor. */
  extractScreeningReport(input: { mimeType: string; base64: string; filename?: string; kind: 'credit' | 'criminal' }): Promise<ScreeningReportExtraction>;
}
```

- [ ] **Step 2: Escribir el test que falla — mock determinista**

En `packages/adapters/src/mocks/glm.mock.test.ts` (ya existe), agregar:

```ts
describe('GlmMockAdapter.extractScreeningReport', () => {
  it('devuelve un veredicto passed determinista para crédito', async () => {
    const adapter = new GlmMockAdapter();
    const result = await adapter.extractScreeningReport({ mimeType: 'application/pdf', base64: 'Zm9v', kind: 'credit' });
    expect(result.verdict).toBe('passed');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.summaryText.length).toBeGreaterThan(0);
  });

  it('devuelve flagged si el filename contiene "flagged" (mismo patrón que ScreeningMockAdapter)', async () => {
    const adapter = new GlmMockAdapter();
    const result = await adapter.extractScreeningReport({ mimeType: 'application/pdf', base64: 'Zm9v', filename: 'flagged-report.pdf', kind: 'criminal' });
    expect(result.verdict).toBe('flagged');
  });
});
```

- [ ] **Step 3: Correr y verificar que falla**

```bash
pnpm --filter @property-manager/adapters exec vitest run glm.mock.test.ts
```

Expected: FAIL — `extractScreeningReport` no existe en `GlmMockAdapter`.

- [ ] **Step 4: Implementar el mock**

En `packages/adapters/src/mocks/glm.mock.ts`, junto a `extractCreditReport`, agregar:

```ts
  async extractScreeningReport(input: {
    mimeType: string;
    base64: string;
    filename?: string;
    kind: 'credit' | 'criminal';
  }): Promise<ScreeningReportExtraction> {
    const flagged = (input.filename ?? '').toLowerCase().includes('flagged');
    return {
      verdict: flagged ? 'flagged' : 'passed',
      summaryText: flagged
        ? `Manual ${input.kind} report indicates concerns worth review.`
        : `Manual ${input.kind} report shows no significant concerns.`,
      confidence: 0.9,
    };
  }
```

Y agregar `ScreeningReportExtraction` al `import type { ... } from '../contracts.js';` de ese archivo.

- [ ] **Step 5: Correr y verificar que pasa**

```bash
pnpm --filter @property-manager/adapters exec vitest run glm.mock.test.ts
```

Expected: PASS.

- [ ] **Step 6: Implementar el real**

En `packages/adapters/src/real/glm.real.ts`, junto a `extractCreditReport`, agregar:

```ts
  async extractScreeningReport(input: {
    mimeType: string;
    base64: string;
    filename?: string;
    kind: 'credit' | 'criminal';
  }): Promise<ScreeningReportExtraction> {
    const kindLabel = input.kind === 'credit' ? 'credit report' : 'criminal background check';
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.ocrModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `This is a tenant ${kindLabel} PDF for a rental applicant. Read it and summarize the key findings in 2-4 sentences. Based on the content, decide a verdict: "passed" if the report shows no significant concerns (good credit standing / no criminal record found), "flagged" if it shows concerns worth human review (poor credit standing, collections, evictions / a criminal record found). If you cannot determine either from the document, use null. Respond as JSON: {"verdict": "passed"|"flagged"|null, "summaryText": string, "confidence": number between 0 and 1}.`,
              },
              {
                type: 'image_url',
                image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`GLM screening report OCR request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as ScreeningReportExtraction;
  }
```

Y agregar `ScreeningReportExtraction` al `import type { ... } from '../contracts.js';` de ese archivo.

- [ ] **Step 7: Verificar compilación de todo el paquete**

```bash
pnpm --filter @property-manager/adapters exec tsc --noEmit
pnpm --filter @property-manager/adapters test
```

Expected: sin errores; toda la suite de `adapters` en verde.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/src/contracts.ts packages/adapters/src/mocks/glm.mock.ts packages/adapters/src/mocks/glm.mock.test.ts packages/adapters/src/real/glm.real.ts
git commit -m "feat: extractScreeningReport en GlmAdapter — OCR genérico de reportes de crédito/antecedentes de cualquier proveedor"
```

---

### Task 2: `recordManualScreeningReport` + ruta de carga

**Files:**
- Modify: `apps/api/src/services/screening.service.ts`
- Modify: `apps/api/src/routes/leads.ts`
- Test: `apps/api/src/services/screening.service.test.ts`
- Test: `apps/api/src/routes/leads.test.ts`

**Interfaces:**
- Consumes: `GlmAdapter.extractScreeningReport` (Tarea 1, vía `getAdapters().glm`).
- Produces: `recordManualScreeningReport(applicationId: string, tenantId: string, kind: ScreeningCheckKind, upload: {mimeType: string; base64: string; filename?: string}): Promise<{ok: true; verdict: 'passed' | 'flagged'} | {ok: false; status: 400 | 404; error: string}>` (exportada desde `screening.service.ts`) — consumida por la ruta nueva en `leads.ts`.

- [ ] **Step 1: Escribir los tests que fallan**

En `apps/api/src/services/screening.service.test.ts`, agregar (junto a los describe blocks existentes, mismo patrón de `seed()`/`cleanup()` ya presente en el archivo):

```ts
describe('recordManualScreeningReport', () => {
  it('registra un veredicto passed y guarda el reporte con la marca [AUTOMATED]', async () => {
    const { applicationId } = await seed();
    const upload = { mimeType: 'application/pdf', base64: Buffer.from('fake pdf bytes').toString('base64'), filename: 'report.pdf' };

    const result = await recordManualScreeningReport(applicationId, TENANT_ID, 'credit', upload);

    expect(result).toEqual({ ok: true, verdict: 'passed' });
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('passed');
    expect(row.creditCheckSummary).toMatch(/^\[AUTOMATED\] /);
    expect(row.creditCheckReportKey).not.toBeNull();
    expect(row.creditCheckCompletedAt).not.toBeNull();
  });

  it('rechaza con 400 cuando el modelo no puede determinar un veredicto', async () => {
    const { applicationId } = await seed();
    const upload = { mimeType: 'application/pdf', base64: Buffer.from('unreadable').toString('base64'), filename: 'unreadable.pdf' };
    vi.spyOn((await import('../config/adapters.js')).getAdapters().glm, 'extractScreeningReport')
      .mockResolvedValueOnce({ verdict: null, summaryText: '', confidence: 0 });

    const result = await recordManualScreeningReport(applicationId, TENANT_ID, 'credit', upload);

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('verdict') });
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBeNull();
  });

  it('sobreescribe un checkeo que estaba awaiting_approval (acción humana explícita, sin guard de estado)', async () => {
    const { applicationId } = await seed();
    await prisma.rentalApplication.update({ where: { id: applicationId }, data: { creditCheckStatus: 'awaiting_approval' } });
    const upload = { mimeType: 'application/pdf', base64: Buffer.from('fake pdf bytes').toString('base64') };

    const result = await recordManualScreeningReport(applicationId, TENANT_ID, 'credit', upload);

    expect(result.ok).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('passed');
  });

  it('devuelve 404 para una aplicación de otro tenant', async () => {
    const { applicationId } = await seed();
    const upload = { mimeType: 'application/pdf', base64: Buffer.from('fake pdf bytes').toString('base64') };

    const result = await recordManualScreeningReport(applicationId, 'tenant_otro', 'credit', upload);

    expect(result).toEqual({ ok: false, status: 404, error: expect.any(String) });
  });
});
```

(Revisa el `seed()` que ya existe en este archivo para confirmar qué helper usar — probablemente el mismo `seed()` de los describe blocks vecinos de screening. Si `seed()` no existe con ese nombre exacto, usa el helper real del archivo, con la misma forma de retorno `{applicationId}`.)

- [ ] **Step 2: Correr y verificar que fallan**

```bash
pnpm --filter @property-manager/api exec vitest run screening.service.test.ts
```

Expected: FAIL — `recordManualScreeningReport` no existe todavía.

- [ ] **Step 3: Implementar en `screening.service.ts`**

Agregar, después de `PROVIDER_BY_KIND`/antes de `getScreeningAdapter` o en cualquier punto del archivo tras las constantes de campo (`STATUS_FIELD`, `SUMMARY_FIELD`, `REPORT_KEY_FIELD`, `COMPLETED_AT_FIELD`, ya existentes y privadas en este archivo — reutilízalas directo, no las vuelvas a declarar):

```ts
const MANUAL_UPLOAD_MIN_CONFIDENCE = 0.5;

/**
 * Registra un reporte de screening que el staff obtuvo por fuera de esta
 * app (de cualquier proveedor) y subió manualmente. A diferencia de
 * `persistTerminalResult`, esto NO respeta el guard de `OPEN_STATUSES`: es
 * una acción humana explícita, no una escritura automática rezagada, así
 * que puede registrar un resultado sin importar el estado actual del
 * checkeo (incluso sobreescribir uno ya cerrado). Si más tarde una cadena
 * automática intenta su propio cierre vía `persistTerminalResult`, el
 * guard de esa función ya existente (`WHERE ... IN ('requested','pending')`)
 * no encuentra la fila y descarta la escritura en silencio -- las dos
 * funciones componen de forma segura sin necesidad de coordinarse.
 */
export async function recordManualScreeningReport(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  upload: { mimeType: string; base64: string; filename?: string },
): Promise<{ ok: true; verdict: 'passed' | 'flagged' } | { ok: false; status: 400 | 404; error: string }> {
  const application = await prisma.rentalApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { id: true },
  });
  if (!application) return { ok: false, status: 404, error: 'Application not found' };

  const { getAdapters } = await import('../config/adapters.js');
  const extraction = await getAdapters().glm.extractScreeningReport({
    mimeType: upload.mimeType, base64: upload.base64, filename: upload.filename, kind,
  });
  if (extraction.verdict === null || extraction.confidence < MANUAL_UPLOAD_MIN_CONFIDENCE) {
    return { ok: false, status: 400, error: 'Could not determine a verdict from this report — review it manually' };
  }

  const env = getEnv();
  const storage = createLocalDocumentStorage({
    rootDir: env.DOCUMENT_STORAGE_DIR,
    publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined,
  });
  const stored = await storage.putObject({
    key: buildDocumentStorageKey({ tenantId, documentId: `${applicationId}-${kind}`, filename: `${kind}-report.pdf` }),
    body: decodeBase64Payload(upload.base64),
    contentType: upload.mimeType,
  });

  const now = new Date();
  await prisma.rentalApplication.updateMany({
    where: { id: applicationId, tenantId },
    data: {
      [STATUS_FIELD[kind]]: extraction.verdict,
      [SUMMARY_FIELD[kind]]: `[AUTOMATED] ${extraction.summaryText}`,
      [REPORT_KEY_FIELD[kind]]: stored.storageKey,
      [COMPLETED_AT_FIELD[kind]]: now,
    },
  });
  return { ok: true, verdict: extraction.verdict };
}
```

Todos los símbolos usados (`prisma`, `getEnv`, `createLocalDocumentStorage`, `buildDocumentStorageKey`, `decodeBase64Payload`, `STATUS_FIELD`, `SUMMARY_FIELD`, `REPORT_KEY_FIELD`, `COMPLETED_AT_FIELD`, `ScreeningCheckKind`) ya están importados/declarados en este archivo — no agregues imports nuevos para esto.

- [ ] **Step 4: Correr y verificar que pasan**

```bash
pnpm --filter @property-manager/api exec vitest run screening.service.test.ts
```

Expected: PASS, tests nuevos y los ~existentes de este archivo.

- [ ] **Step 5: Ruta nueva en `leads.ts`**

`apps/api/src/routes/leads.ts` ya importa `z`, `requireRole`, `getAdapters`, y `approveScreening` de `screening.service.js` (línea 39) — agrega `recordManualScreeningReport` a esa misma línea de import.

Junto a la ruta existente `POST /applications/:applicationId/screening/:kind/approve`, agregar:

```ts
const uploadReportSchema = z.object({
  mimeType: z.string().min(5),
  base64: z.string().min(10),
  filename: z.string().optional(),
});
const MAX_REPORT_BASE64_LENGTH = 1_500_000; // mismo tope que idDocumentBase64 en rental-application.service.ts

leadsRouter.post(
  '/applications/:applicationId/screening/:kind/upload-report',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { applicationId, kind } = req.params;
      if (kind !== 'credit' && kind !== 'criminal') {
        res.status(400).json({ error: 'Invalid screening kind' });
        return;
      }
      const parsed = uploadReportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid upload', details: parsed.error.flatten() });
        return;
      }
      if (parsed.data.base64.length > MAX_REPORT_BASE64_LENGTH) {
        res.status(400).json({ error: 'The report file is too large' });
        return;
      }
      const result = await recordManualScreeningReport(applicationId, user.tenantId, kind, parsed.data);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, verdict: result.verdict });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 6: Test de la ruta**

En `apps/api/src/routes/leads.test.ts`, agregar (mismo patrón de verificación por grep del código fuente que ya usa este archivo para las demás rutas de screening — revisa el test existente de la ruta de aprobación como referencia exacta del estilo):

```ts
it('POST /applications/:id/screening/:kind/upload-report existe con requireAuth y requireRole(property_manager, broker)', () => {
  const source = readFileSync(new URL('./leads.ts', import.meta.url), 'utf-8');
  expect(source).toMatch(/leadsRouter\.post\(\s*'\/applications\/:applicationId\/screening\/:kind\/upload-report'/);
  const routeBlock = source.slice(source.indexOf("'/applications/:applicationId/screening/:kind/upload-report'"));
  expect(routeBlock.slice(0, 200)).toMatch(/requireAuth/);
  expect(routeBlock.slice(0, 200)).toMatch(/requireRole\('property_manager', 'broker'\)/);
});
```

- [ ] **Step 7: Correr toda la suite de `api` y verificar compilación**

```bash
pnpm --filter @property-manager/api exec tsc --noEmit
pnpm --filter @property-manager/api test
```

Expected: sin errores; toda la suite en verde.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/screening.service.ts apps/api/src/services/screening.service.test.ts apps/api/src/routes/leads.ts apps/api/src/routes/leads.test.ts
git commit -m "feat: registrar un reporte de screening subido manualmente (cualquier proveedor)"
```

---

### Task 3: UI de carga + roadmap + regresión completa

**Files:**
- Modify: `apps/web/src/pages/ShowingsPage.tsx`
- Modify: `docs/PRODUCT_ROADMAP.md`

**Interfaces:**
- Consumes: `POST /leads/applications/:applicationId/screening/:kind/upload-report` (Tarea 2) — body `{mimeType, base64, filename?}`, devuelve `{ok:true, verdict}` o `{ok:false, error}`.

- [ ] **Step 1: Botón de carga en `ScreeningBlock`**

En `apps/web/src/pages/ShowingsPage.tsx`, dentro de `ScreeningBlock` (la función que ya tiene `approve`/`handleDownload`), agregar un `useRef` para el input de archivo, la mutación de carga, y el botón — mismo patrón que `BillsPage.tsx` (`fileToBase64` con `FileReader.readAsDataURL` + strip del prefijo `data:...;base64,`):

```tsx
import { useRef, useState } from 'react';
// (agregar useRef al import ya existente de 'react' en la línea 1 del archivo, junto a useEffect/useState)
```

Dentro de `ScreeningBlock`, junto a la declaración de `approve`:

```tsx
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await fileToBase64(file);
      return apiFetch(`/leads/applications/${applicationId}/screening/${kind}/upload-report`, {
        method: 'POST',
        body: JSON.stringify({ mimeType: file.type || 'application/pdf', base64, filename: file.name }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['showing-application'] }),
  });
```

Y en el JSX, junto al botón de descarga existente (después del bloque `{downloadError && ...}`), agregar el botón de carga y el input oculto, visible con el mismo gate de rol que la aprobación (`canApprove`):

```tsx
      {canApprove && (
        <>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={upload.isPending}
            className="mt-0.5 text-teal-600 hover:underline disabled:opacity-50"
          >
            {upload.isPending ? 'Uploading…' : 'Upload report manually'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = '';
            }}
          />
        </>
      )}
      {upload.isError && (
        <p className="mt-0.5 text-red-600">
          {upload.error instanceof ApiError ? upload.error.message : 'Could not process the uploaded report.'}
        </p>
      )}
```

Al final del archivo (o junto a cualquier otra función helper de módulo ya existente, como `formatDate`), agregar la misma función que usa `BillsPage.tsx`:

```ts
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
```

Verifica que `ApiError` ya está importado en este archivo (línea 4: `import { API_BASE, apiFetch, ApiError, getAccessToken } from '../lib/apiClient';` — ya lo está, no hace falta agregarlo) antes de usarlo en el mensaje de error.

- [ ] **Step 2: Verificar compilación y suite**

```bash
pnpm --filter @property-manager/web exec tsc --noEmit
pnpm --filter @property-manager/web test
```

Expected: sin errores; los tests existentes de `web` en verde (no hay tests de componente para `ShowingsPage.tsx` hoy — consistente con la convención ya establecida en tareas anteriores de esta fase).

- [ ] **Step 3: Actualizar el roadmap**

En `docs/PRODUCT_ROADMAP.md`, sección 2.2, marcar el "Nivel 3 — PDF parser / OCR" como entregado: el staff puede subir un reporte en PDF de cualquier proveedor y el sistema extrae veredicto + resumen vía GLM (visión/OCR), independiente de la decisión de proveedor de antecedentes penales pendiente.

- [ ] **Step 4: Regresión completa del monorepo**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Expected: todo verde en los 4 paquetes. Si algo falla, no commitear: reportar BLOCKED.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/ShowingsPage.tsx docs/PRODUCT_ROADMAP.md
git commit -m "feat: botón de carga manual de reporte de screening en Showings, roadmap"
```

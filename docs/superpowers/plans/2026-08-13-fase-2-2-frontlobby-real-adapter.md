# FrontLobby Real Adapter (Fase 2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el checkeo de crédito mock por uno real contra FrontLobby (Playwright), con aprobación manual del cargo real ($18.99/checkeo) y notificación proactiva al staff. Antecedentes penales (Sterling) sigue en mock — no existe cuenta todavía.

**Architecture:** El enrutamiento real-vs-mock vive en `screening.service.ts` (no en el factory síncrono de adapters — ver Sección 4 del spec). `FrontLobbyScreeningAdapter` implementa el contrato `ScreeningAdapter` ya existente con Playwright real: login con credenciales de la bóveda, auto-provisión de la Property en FrontLobby si no existe, llenado del formulario real de 3 pasos, y sondeo posterior contra la página de Reports con extracción del PDF vía `GlmAdapter` (OCR). El veredicto usa un umbral de score, siempre etiquetado `[AUTOMATED]`.

**Tech Stack:** Playwright (dependencia nueva), TypeScript, Prisma, Vitest, Express, BullMQ (sin cambios), React + TanStack Query.

## Global Constraints

- El asistente que ejecuta este plan (subagentes incluidos) **nunca** debe tocar, loguear ni pedir la contraseña real de FrontLobby — las credenciales viven cifradas en la bóveda (`IntegrationConfig`, Tarea 3 de la Fase 2.2 original) y solo el código en ejecución (no el asistente) las descifra y usa dentro de Playwright.
- Ningún resultado terminal de screening puede quedar en silencio: todo fallo (login, property, formulario, OCR) se traduce en `'failed'` con una razón concreta, nunca en un veredicto inventado ni en un estado atascado sin notificar.
- El checkeo de crédito real **nunca** se dispara automáticamente — requiere aprobación manual explícita de un `property_manager`/`broker` vía la ruta nueva, porque cada corrida cuesta $18.99 reales. El checkeo de antecedentes penales (mock, sin costo) sigue disparando automático como hoy.
- Todo veredicto derivado de un umbral de score se guarda con el prefijo `[AUTOMATED]` en el summary — nunca se presenta como si un humano lo hubiera revisado.
- `getAdapters()` (`apps/api/src/config/adapters.ts`) es síncrono, cacheado una sola vez por proceso, y NO debe volverse async ni ganar parámetros nuevos — 64 call sites en `apps/api/src` lo consumen así hoy. El enrutamiento real/mock de screening vive en `screening.service.ts`, no ahí.
- Nunca usar `prisma migrate reset`, `prisma db push`, ni pasar `$DATABASE_URL` como `--shadow-database-url`.
- Si un test falla o `tsc` no compila, se reporta BLOCKED — nunca se commitea en rojo.

---

### Task 1: Schema — identidad separada y fecha de inicio en la dirección

**Files:**
- Modify: `apps/api/prisma/schema.prisma:887-947` (modelo `RentalApplication`)
- Test: `apps/api/src/services/rental-application.service.test.ts` (extender fixtures existentes, Task 2 escribe los tests de comportamiento nuevo)

**Interfaces:**
- Produces: columnas nuevas `applicantFirstName String?`, `applicantLastName String?`, `currentAddressStartDateAt DateTime?` en `RentalApplication`, consumidas por Task 2 (formulario), Task 4 (adapter real) y Task 6 (UI, solo lectura vía el tipo `ApplicationDetail`).

- [ ] **Step 1: Agregar las columnas al schema**

En `apps/api/prisma/schema.prisma`, dentro del modelo `RentalApplication`, justo después de la línea `applicantFullName String?` (línea 930):

```prisma
  applicantFullName    String?
  // Fase 2.2 (adapter real de FrontLobby): el formulario real de FrontLobby
  // pide nombre y apellido por separado, no un campo único. applicantFullName
  // se sigue guardando (concatenación de los dos) para no romper a quien ya
  // lo consume (notificaciones al staff, ScreeningMockAdapter).
  applicantFirstName   String?
  applicantLastName    String?
  // FrontLobby exige "¿desde cuándo vives en esa dirección?" — dato que el
  // resto del sistema nunca pidió hasta ahora.
  currentAddressStartDateAt DateTime?
```

- [ ] **Step 2: Migrar**

```bash
pnpm --filter @property-manager/api exec prisma migrate dev --name add_frontlobby_identity_fields
```

Expected: crea una migración nueva en `apps/api/prisma/migrations/`, aplica limpio contra la base de datos de desarrollo (aditivo, sin `DROP`).

- [ ] **Step 3: Verificar que el cliente Prisma regenerado compila**

```bash
pnpm --filter @property-manager/api exec tsc --noEmit
```

Expected: sin errores (los campos nuevos son opcionales, ningún código existente los referencia todavía).

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat: separar nombre/apellido del aplicante y capturar fecha de inicio en la dirección"
```

---

### Task 2: Formulario público — nombre separado + fecha de inicio en la dirección

**Files:**
- Modify: `apps/web/src/pages/ApplyPage.tsx:70-71,165` (inputs del formulario)
- Modify: `apps/api/src/routes/leads.ts:231-238` (extracción del body)
- Modify: `apps/api/src/services/rental-application.service.ts:143-283` (`SubmitApplicationInput`, validación, `applicantFullName`)
- Test: `apps/api/src/services/rental-application.service.test.ts`

**Interfaces:**
- Consumes: columnas de Task 1 (`applicantFirstName`, `applicantLastName`, `currentAddressStartDateAt`).
- Produces: `SubmitApplicationInput` gana `applicantFirstName: string`, `applicantLastName: string`, `currentAddressStartDate: string` (ISO date) — consumido por Task 4 (el adapter real los necesita para el formulario de FrontLobby) y por cualquier notificación que ya use `applicantFullName` (sin cambios, sigue existiendo).

- [ ] **Step 1: Escribir el test que falla — nombre separado requerido**

En `apps/api/src/services/rental-application.service.test.ts`, localizar `validSubmission()` (el helper compartido por ~15 tests existentes) y agregar los dos campos nuevos con valores por defecto realistas, junto a los ya existentes de `dateOfBirth`/`currentAddress`/etc.:

```ts
function validSubmission(overrides: Partial<SubmitApplicationInput> = {}): SubmitApplicationInput {
  return {
    applicantFullName: 'Jane Prospect', // se sigue mandando, ahora derivado abajo
    applicantFirstName: 'Jane',
    applicantLastName: 'Prospect',
    dateOfBirth: '1990-05-15',
    currentAddress: '123 Test St',
    currentCity: 'Vancouver',
    currentProvince: 'British Columbia',
    currentPostalCode: 'V6B 1A1',
    currentAddressStartDate: '2022-01-01',
    consentApplication: true,
    consentCreditCheck: true,
    consentPoliceCheck: true,
    idDocumentFilename: 'id.jpg',
    idDocumentMimeType: 'image/jpeg',
    idDocumentBase64: Buffer.from('fake-id-bytes').toString('base64'),
    ...overrides,
  };
}

it('rechaza applicantFirstName vacío con 400', async () => {
  const { token } = await seedInvitedApplication();
  const result = await submitRentalApplication(token, validSubmission({ applicantFirstName: '' }), deps);
  expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('applicantFirstName') });
});

it('rechaza currentAddressStartDate no parseable con 400, no 500', async () => {
  const { token } = await seedInvitedApplication();
  const result = await submitRentalApplication(token, validSubmission({ currentAddressStartDate: 'garbage' }), deps);
  expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('currentAddressStartDate') });
});

it('guarda applicantFirstName/applicantLastName y deriva applicantFullName', async () => {
  const { token, applicationId } = await seedInvitedApplication();
  await submitRentalApplication(token, validSubmission({ applicantFirstName: 'Ana', applicantLastName: 'García' }), deps);
  const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
  expect(row.applicantFirstName).toBe('Ana');
  expect(row.applicantLastName).toBe('García');
  expect(row.applicantFullName).toBe('Ana García');
});
```

(Usar el helper `seedInvitedApplication()` ya existente en el archivo — mismo patrón que el resto de tests de esta suite.)

- [ ] **Step 2: Correr y verificar que fallan**

```bash
pnpm --filter @property-manager/api exec vitest run rental-application.service.test.ts
```

Expected: FAIL — `SubmitApplicationInput` todavía no tiene `applicantFirstName`/`applicantLastName`/`currentAddressStartDate`.

- [ ] **Step 3: Extender el tipo y la validación en `rental-application.service.ts`**

En la interfaz `SubmitApplicationInput` (línea ~143), reemplazar:

```ts
  applicantFullName: string;
```

por:

```ts
  // Fase 2.2 (adapter real): FrontLobby pide nombre y apellido por
  // separado. applicantFullName se sigue aceptando (derivado en el
  // frontend o el propio caller) por si algún consumidor viejo todavía lo
  // manda, pero ya no se usa para nada — se deriva de first+last aquí.
  applicantFirstName: string;
  applicantLastName: string;
```

Y agregar, junto a `currentPostalCode: string;`:

```ts
  currentAddressStartDate: string; // ISO date
```

En el bloque de validación (línea ~221, donde hoy dice `if (!input.applicantFullName.trim())`), reemplazar por:

```ts
  if (!input.applicantFirstName.trim()) {
    return { ok: false, status: 400, error: 'applicantFirstName is required' };
  }
  if (!input.applicantLastName.trim()) {
    return { ok: false, status: 400, error: 'applicantLastName is required' };
  }
```

Después del bloque que valida `dateOfBirth` (línea ~229-232), agregar el mismo patrón de "no vacío y parsea como fecha real" para la dirección:

```ts
  const parsedAddressStartDate = new Date(input.currentAddressStartDate);
  if (!input.currentAddressStartDate.trim() || Number.isNaN(parsedAddressStartDate.getTime())) {
    return { ok: false, status: 400, error: 'A valid currentAddressStartDate is required' };
  }
```

En el `updateMany` (línea ~271-283), reemplazar:

```ts
      applicantFullName: input.applicantFullName.trim(),
```

por:

```ts
      applicantFirstName: input.applicantFirstName.trim(),
      applicantLastName: input.applicantLastName.trim(),
      applicantFullName: `${input.applicantFirstName.trim()} ${input.applicantLastName.trim()}`,
```

y agregar, junto a `currentPostalCode: input.currentPostalCode.trim(),`:

```ts
      currentAddressStartDateAt: parsedAddressStartDate,
```

- [ ] **Step 4: Correr y verificar que pasan**

```bash
pnpm --filter @property-manager/api exec vitest run rental-application.service.test.ts
```

Expected: PASS, todos los tests (los nuevos y los ~15 existentes que usan `validSubmission()`).

- [ ] **Step 5: `leads.ts` — extracción del body público**

En `apps/api/src/routes/leads.ts`, reemplazar la línea:

```ts
        applicantFullName: typeof body.applicantFullName === 'string' ? body.applicantFullName : '',
```

por:

```ts
        applicantFirstName: typeof body.applicantFirstName === 'string' ? body.applicantFirstName : '',
        applicantLastName: typeof body.applicantLastName === 'string' ? body.applicantLastName : '',
```

y agregar, junto a la línea de `currentPostalCode`:

```ts
        currentAddressStartDate: typeof body.currentAddressStartDate === 'string' ? body.currentAddressStartDate : '',
```

- [ ] **Step 6: `ApplyPage.tsx` — formulario público**

En `apps/web/src/pages/ApplyPage.tsx`, reemplazar la línea del payload (línea 70):

```ts
      applicantFullName: String(form.get('applicantFullName') ?? ''),
```

por:

```ts
      applicantFirstName: String(form.get('applicantFirstName') ?? ''),
      applicantLastName: String(form.get('applicantLastName') ?? ''),
```

y agregar, junto a la línea de `currentPostalCode` del payload:

```ts
      currentAddressStartDate: String(form.get('currentAddressStartDate') ?? ''),
```

Reemplazar el input único (línea 165):

```tsx
          <input name="applicantFullName" type="text" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
```

por dos inputs, mismo estilo:

```tsx
          <input name="applicantFirstName" type="text" required placeholder="First name" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
          <input name="applicantLastName" type="text" required placeholder="Last name" className="mt-1 mt-2 w-full rounded-md border border-slate-300 px-3 py-2" />
```

Y agregar, siguiendo el mismo patrón que el input de `dateOfBirth` (línea 170: `type="date" required`), un input nuevo para la fecha de inicio en la dirección, en el bloque donde ya están `currentAddress`/`currentCity`/`currentProvince`/`currentPostalCode`:

```tsx
          <input name="currentAddressStartDate" type="date" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
```

- [ ] **Step 7: Verificar compilación y suite del paquete web**

```bash
pnpm --filter @property-manager/web exec tsc --noEmit
pnpm --filter @property-manager/web test
```

Expected: sin errores; los 2 tests existentes de `web` siguen en verde (no hay tests unitarios de `ApplyPage.tsx` hoy — no se agregan en este task, coincide con la convención ya establecida en la Fase 2.2 original para esta página).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/ApplyPage.tsx apps/api/src/routes/leads.ts apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts
git commit -m "feat: capturar nombre/apellido separado y fecha de inicio en la dirección"
```

---

### Task 3: `GlmAdapter.extractCreditReport` — OCR del reporte de crédito

**Files:**
- Modify: `packages/adapters/src/contracts.ts` (interfaz `GlmAdapter`, tipo nuevo `CreditReportExtraction`)
- Modify: `packages/adapters/src/mocks/glm.mock.ts` (implementación determinista)
- Modify: `packages/adapters/src/real/glm.real.ts` (implementación real, mismo patrón HTTP que `extractReceipt`)
- Test: `packages/adapters/src/mocks/glm.mock.test.ts` (crear si no existe; si existe, extender)

**Interfaces:**
- Produces: `GlmAdapter.extractCreditReport(input: { mimeType: string; base64: string; filename?: string }): Promise<CreditReportExtraction>`, con `CreditReportExtraction = { score: number | null; aiSummaryText: string; confidence: number }` — consumido por Task 4 (`FrontLobbyScreeningAdapter.pollResult`).

- [ ] **Step 1: Tipo y contrato nuevos**

En `packages/adapters/src/contracts.ts`, buscar la interfaz `GlmAdapter` (línea ~223) y, justo antes, agregar:

```ts
export interface CreditReportExtraction {
  /** null si el modelo no pudo leer el gauge de score del PDF. */
  score: number | null;
  /** Texto completo de la sección "AI Summary" del reporte, tal cual. */
  aiSummaryText: string;
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
  /** OCR de un reporte de crédito (PDF) — score + texto del resumen de IA. */
  extractCreditReport(input: { mimeType: string; base64: string; filename?: string }): Promise<CreditReportExtraction>;
}
```

- [ ] **Step 2: Escribir el test que falla — mock determinista**

Crear `packages/adapters/src/mocks/glm.mock.test.ts` (si el archivo no existe todavía — verificar con `ls packages/adapters/src/mocks/*.test.ts` antes de crear, para no pisar un archivo existente):

```ts
import { describe, expect, it } from 'vitest';
import { GlmMockAdapter } from './glm.mock.js';

describe('GlmMockAdapter.extractCreditReport', () => {
  it('devuelve un score determinista y texto de resumen', async () => {
    const adapter = new GlmMockAdapter();
    const result = await adapter.extractCreditReport({ mimeType: 'application/pdf', base64: 'Zm9v' });
    expect(result.score).toBe(675);
    expect(result.aiSummaryText).toContain('credit score');
    expect(result.confidence).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Correr y verificar que falla**

```bash
pnpm --filter @property-manager/adapters exec vitest run glm.mock.test.ts
```

Expected: FAIL — `extractCreditReport` no existe en `GlmMockAdapter`.

- [ ] **Step 4: Implementar el mock**

En `packages/adapters/src/mocks/glm.mock.ts`, junto al método `extractReceipt` existente, agregar:

```ts
  async extractCreditReport(_input: {
    mimeType: string;
    base64: string;
    filename?: string;
  }): Promise<CreditReportExtraction> {
    return {
      score: 675,
      aiSummaryText: 'The applicant has a credit score of 675, which is categorized as good. No outstanding balances on most tradelines.',
      confidence: 0.9,
    };
  }
```

Y agregar `CreditReportExtraction` al `import type { ... } from '../contracts.js';` de ese archivo.

- [ ] **Step 5: Correr y verificar que pasa**

```bash
pnpm --filter @property-manager/adapters exec vitest run glm.mock.test.ts
```

Expected: PASS.

- [ ] **Step 6: Implementar el real (mismo patrón HTTP que `extractReceipt`)**

En `packages/adapters/src/real/glm.real.ts`, junto al método `extractReceipt` existente, agregar:

```ts
  async extractCreditReport(input: { mimeType: string; base64: string; filename?: string }): Promise<CreditReportExtraction> {
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
                text: 'This is a tenant credit report PDF. Find the credit score gauge (a number roughly 300-900) and the "AI Summary" section text. Respond as JSON: {"score": number|null, "aiSummaryText": string, "confidence": number between 0 and 1}.',
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
      throw new Error(`GLM credit report OCR request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as CreditReportExtraction;
  }
```

Y agregar `CreditReportExtraction` al `import type { ... } from '../contracts.js';` de ese archivo.

- [ ] **Step 7: Verificar compilación de todo el paquete**

```bash
pnpm --filter @property-manager/adapters exec tsc --noEmit
pnpm --filter @property-manager/adapters test
```

Expected: sin errores; toda la suite de `adapters` en verde.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/src/contracts.ts packages/adapters/src/mocks/glm.mock.ts packages/adapters/src/mocks/glm.mock.test.ts packages/adapters/src/real/glm.real.ts
git commit -m "feat: extractCreditReport en GlmAdapter — OCR de score y resumen de reportes de crédito"
```

---

### Task 4: `FrontLobbyScreeningAdapter` — Playwright real contra FrontLobby

**Files:**
- Create: `packages/adapters/src/real/front-lobby.real.ts`
- Create: `packages/adapters/src/real/front-lobby.helpers.ts` (funciones puras, testeables sin navegador)
- Test: `packages/adapters/src/real/front-lobby.helpers.test.ts`
- Modify: `packages/adapters/package.json` (dependencia nueva `playwright`)
- Modify: `packages/adapters/src/contracts.ts` (extender `ScreeningApplicantInput` con los campos nuevos de identidad)

**Interfaces:**
- Consumes: `GlmAdapter.extractCreditReport` (Task 3), `ScreeningApplicantInput`/`ScreeningRunResult`/`ScreeningCheckKind` (contrato ya existente), credenciales `{ username: string; password: string }` de la bóveda (Task 5 las inyecta al construir esta clase — este task NO llama a la bóveda directamente, recibe las credenciales ya resueltas por el constructor, para mantener este archivo sin dependencia de Prisma/BD).
- Produces: `class FrontLobbyScreeningAdapter implements ScreeningAdapter`, constructor `(credentials: { username: string; password: string })`. Funciones puras exportadas de `front-lobby.helpers.ts`: `scoreToVerdict(score: number): 'passed' | 'flagged'`, `formatAutomatedSummary(score: number, aiSummaryText: string): string`, `encodeProviderRef(fullName: string, submittedAtIso: string): string`, `decodeProviderRef(providerRef: string): { fullName: string; submittedAtIso: string }` — consumidas por Task 5 (`isSimulatedScreening`/`isMockScreening` NO las necesita, pero `pollScreeningResult` sí necesita `decodeProviderRef` indirectamente vía esta clase).

**IMPORTANTE — límite real de lo que este task puede probar:** no existe un entorno sandbox de FrontLobby. La lógica de navegación con Playwright (login, llenar formularios, buscar en la tabla de Reports) **no se puede cubrir con un test automatizado** sin generar cargos reales contra la cuenta real del usuario. Este task escribe tests reales y en verde para toda la lógica que SÍ es pura (umbral de score, formato del summary, codificación de `providerRef`) en `front-lobby.helpers.ts`, y dedica `front-lobby.real.ts` a la orquestación de Playwright sin test automatizado — eso se verifica con una corrida real coordinada con el usuario, fuera de este plan (requiere su consentimiento explícito para el cargo de $18.99, y ya existe la aprobación manual de la Sección 3 del spec como red de seguridad: nada corre sin que un humano apruebe el gasto). Si algo en la navegación real no funciona como se documentó aquí (selectores, texto de la columna Status), el resultado es `'failed'` con el error real de Playwright — nunca un veredicto inventado, consistente con la restricción global del proyecto.

- [ ] **Step 1: Agregar Playwright como dependencia**

```bash
pnpm --filter @property-manager/adapters add playwright
pnpm --filter @property-manager/adapters exec playwright install chromium
```

Expected: `playwright` aparece en `packages/adapters/package.json` bajo `dependencies`; el binario de Chromium queda instalado localmente para desarrollo/tests. Documentar en `docs/PROJECT_HANDOFF.md` (buscar la sección de requisitos de despliegue existente y agregar una línea) que el entorno de producción necesita correr `playwright install chromium --with-deps` como parte del build/deploy.

- [ ] **Step 2: Extender `ScreeningApplicantInput` con los campos nuevos de identidad**

En `packages/adapters/src/contracts.ts`, la interfaz `ScreeningApplicantInput` ya existe con `fullName`/`dateOfBirth`/`currentAddress`/`currentCity`/`currentProvince`/`currentPostalCode`. Agregar:

```ts
export interface ScreeningApplicantInput {
  fullName: string;
  firstName: string; // NUEVO — FrontLobby pide nombre y apellido por separado
  lastName: string; // NUEVO
  dateOfBirth: string; // ISO YYYY-MM-DD
  currentAddress: string;
  currentCity: string;
  currentProvince: string;
  currentPostalCode: string;
  currentAddressStartDate: string; // NUEVO — ISO YYYY-MM-DD
  email?: string;
  phone?: string;
}
```

`ScreeningMockAdapter` no necesita cambios (no usa estos campos, solo `fullName`). El único llamador real (`screening.service.ts`, Task 5) actualiza el objeto que arma para incluir los campos nuevos.

- [ ] **Step 3: Escribir los tests de las funciones puras (fallan primero)**

Crear `packages/adapters/src/real/front-lobby.helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeProviderRef, encodeProviderRef, formatAutomatedSummary, scoreToVerdict } from './front-lobby.helpers.js';

describe('scoreToVerdict', () => {
  it('score >= 620 es passed', () => {
    expect(scoreToVerdict(620)).toBe('passed');
    expect(scoreToVerdict(900)).toBe('passed');
  });
  it('score < 620 es flagged', () => {
    expect(scoreToVerdict(619)).toBe('flagged');
    expect(scoreToVerdict(300)).toBe('flagged');
  });
});

describe('formatAutomatedSummary', () => {
  it('etiqueta el summary como automático y conserva el texto completo', () => {
    const result = formatAutomatedSummary(675, 'The applicant has a good credit history.');
    expect(result).toMatch(/^\[AUTOMATED\]/);
    expect(result).toContain('675');
    expect(result).toContain('passed by threshold');
    expect(result).toContain('The applicant has a good credit history.');
  });
});

describe('encodeProviderRef / decodeProviderRef', () => {
  it('hace round-trip del nombre completo y el timestamp', () => {
    const ref = encodeProviderRef('Jane Prospect', '2026-08-13T10:00:00.000Z');
    const decoded = decodeProviderRef(ref);
    expect(decoded.fullName).toBe('Jane Prospect');
    expect(decoded.submittedAtIso).toBe('2026-08-13T10:00:00.000Z');
  });
});
```

- [ ] **Step 4: Correr y verificar que fallan**

```bash
pnpm --filter @property-manager/adapters exec vitest run front-lobby.helpers.test.ts
```

Expected: FAIL — el archivo `front-lobby.helpers.ts` todavía no existe.

- [ ] **Step 5: Implementar las funciones puras**

Crear `packages/adapters/src/real/front-lobby.helpers.ts`:

```ts
/**
 * Funciones puras del adapter real de FrontLobby — sin Playwright, sin red,
 * completamente testeables. La orquestación con navegador vive en
 * `front-lobby.real.ts` y las importa.
 */

/** Umbral de score usado para el veredicto automático (Sección 8 del spec). */
export const CREDIT_SCORE_PASS_THRESHOLD = 620;

export function scoreToVerdict(score: number): 'passed' | 'flagged' {
  return score >= CREDIT_SCORE_PASS_THRESHOLD ? 'passed' : 'flagged';
}

/**
 * El summary persistido SIEMPRE deja claro que el veredicto es automático
 * por umbral, y SIEMPRE incluye el texto completo del resumen de IA de
 * FrontLobby — las señales de riesgo que ese texto mencione (colecciones,
 * bancarrota) no entran al umbral, pero el staff las sigue viendo aquí.
 */
export function formatAutomatedSummary(score: number, aiSummaryText: string): string {
  const verdict = scoreToVerdict(score);
  return `[AUTOMATED] Credit score ${score} — ${verdict} by threshold >=${CREDIT_SCORE_PASS_THRESHOLD}.\n\n${aiSummaryText}`;
}

const PROVIDER_REF_SEPARATOR = '|frontlobby|';

/**
 * FrontLobby no expuso (en el recorrido del formulario) un ID de
 * confirmación explícito tras enviar un checkeo — el `providerRef` se
 * compone con el nombre completo y el timestamp de envío, suficiente para
 * volver a encontrar la fila correcta en /tenant-screening/reports por
 * nombre más tarde (ver Sección 6-7 del spec). Si una corrida real expone
 * un ID propio de FrontLobby, usarlo en vez de este compuesto.
 */
export function encodeProviderRef(fullName: string, submittedAtIso: string): string {
  return `${fullName}${PROVIDER_REF_SEPARATOR}${submittedAtIso}`;
}

export function decodeProviderRef(providerRef: string): { fullName: string; submittedAtIso: string } {
  const [fullName, submittedAtIso] = providerRef.split(PROVIDER_REF_SEPARATOR);
  return { fullName: fullName ?? '', submittedAtIso: submittedAtIso ?? '' };
}
```

- [ ] **Step 6: Correr y verificar que pasan**

```bash
pnpm --filter @property-manager/adapters exec vitest run front-lobby.helpers.test.ts
```

Expected: PASS.

- [ ] **Step 7: Implementar `FrontLobbyScreeningAdapter`**

Crear `packages/adapters/src/real/front-lobby.real.ts`:

```ts
/**
 * Adapter real de FrontLobby (checkeo de crédito) vía Playwright. Un
 * navegador nuevo por llamada (nunca sesión colgada) — mismo principio que
 * el resto de esta feature. La navegación real NO tiene test automatizado
 * (ver el task que crea este archivo) — cualquier fallo se traduce en
 * `{status: 'failed', reason: ...}` con el error real, nunca en un
 * resultado inventado.
 */
import { chromium, type Browser, type Page } from 'playwright';
import type {
  ScreeningAdapter,
  ScreeningApplicantInput,
  ScreeningCheckKind,
  ScreeningRunResult,
  GlmAdapter,
} from '../contracts.js';
import { decodeProviderRef, encodeProviderRef, formatAutomatedSummary, scoreToVerdict } from './front-lobby.helpers.js';

const FRONTLOBBY_BASE_URL = 'https://app.frontlobby.com';

export interface FrontLobbyProperty {
  name: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
}

export class FrontLobbyScreeningAdapter implements ScreeningAdapter {
  readonly name = 'screening_playwright' as const;

  constructor(
    private readonly credentials: { username: string; password: string },
    private readonly glm: GlmAdapter,
  ) {}

  private async withBrowser<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser: Browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await this.login(page);
      return await fn(page);
    } finally {
      await browser.close();
    }
  }

  private async login(page: Page): Promise<void> {
    await page.goto(`${FRONTLOBBY_BASE_URL}/login`);
    await page.fill('#email', this.credentials.username);
    await page.fill('#password', this.credentials.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${FRONTLOBBY_BASE_URL}/dashboard`, { timeout: 15_000 });
  }

  private async ensureProperty(page: Page, property: FrontLobbyProperty): Promise<void> {
    await page.goto(`${FRONTLOBBY_BASE_URL}/property`);
    await page.fill('input[placeholder="Search for address..."]', property.address);
    const existingRow = page.getByRole('row', { name: new RegExp(property.address, 'i') });
    if (await existingRow.count() > 0) return;

    await page.click('text=+ Add Property');
    await page.getByLabel('Property Name').fill(property.name);
    await page.getByLabel('Street').fill(property.address);
    await page.getByLabel('City/Town').fill(property.city);
    await page.getByLabel('Country').selectOption({ label: 'Canada' });
    await page.getByLabel('Region').selectOption({ label: property.province });
    await page.getByLabel('Postal Code').fill(property.postalCode);
    await page.click('button:has-text("Save")');
    await page.waitForSelector(`text=${property.address}`, { timeout: 10_000 });
  }

  private async fillApplicantDetails(page: Page, input: ScreeningApplicantInput, property: FrontLobbyProperty): Promise<void> {
    await page.getByLabel('First name').fill(input.firstName);
    await page.getByLabel('Last name').fill(input.lastName);
    const [year, month, day] = input.dateOfBirth.split('-').map(Number);
    await page.getByLabel('Date of birth').locator('select').nth(0).selectOption({ value: String(month! - 1) });
    await page.getByLabel('Date of birth').locator('select').nth(1).selectOption({ label: String(day) });
    await page.getByLabel('Date of birth').locator('select').nth(2).selectOption({ label: String(year) });
    await page.getByLabel('Street').fill(input.currentAddress);
    await page.getByLabel('City/Town').fill(input.currentCity);
    await page.getByLabel('Province').selectOption({ label: input.currentProvince });
    await page.getByLabel('Postal Code').fill(input.currentPostalCode);
    const [startYear, startMonth, startDay] = input.currentAddressStartDate.split('-').map(Number);
    await page.getByLabel('Address start date').locator('select').nth(0).selectOption({ value: String(startMonth! - 1) });
    await page.getByLabel('Address start date').locator('select').nth(1).selectOption({ label: String(startDay) });
    await page.getByLabel('Address start date').locator('select').nth(2).selectOption({ label: String(startYear) });
    await page.getByLabel('Property this Screening is for').click();
    await page.getByText(property.address).click();
  }

  async runCheck(kind: ScreeningCheckKind, input: ScreeningApplicantInput): Promise<ScreeningRunResult> {
    if (kind !== 'credit') {
      return { status: 'failed', reason: 'FrontLobbyScreeningAdapter only handles credit checks' };
    }
    try {
      return await this.withBrowser(async (page) => {
        await page.goto(`${FRONTLOBBY_BASE_URL}/tenant-screening`);
        await page.click('text=Screen Tenant');
        await page.click('text=You Pay and You Fill Out Information');
        await page.click('button:has-text("Continue")');
        await page.click('text=Credit Report');
        await page.click('button:has-text("Continue")');
        const property: FrontLobbyProperty = {
          name: input.currentAddress,
          address: input.currentAddress,
          city: input.currentCity,
          province: input.currentProvince,
          postalCode: input.currentPostalCode,
        };
        await this.ensureProperty(page, property);
        await this.fillApplicantDetails(page, input, property);
        await page.click('button:has-text("Continue")');
        // Paso 4 (confirmación/pago) — no verificado contra la app real
        // (ver la nota del task que creó este archivo). Confirmar el envío
        // real y, si aparece un ID propio de FrontLobby, preferirlo sobre
        // encodeProviderRef.
        await page.click('button:has-text("Submit")');
        const submittedAtIso = new Date().toISOString();
        return { status: 'pending', providerRef: encodeProviderRef(input.fullName, submittedAtIso) };
      });
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : 'Unknown FrontLobby error' };
    }
  }

  async pollResult(kind: ScreeningCheckKind, providerRef: string): Promise<ScreeningRunResult> {
    if (kind !== 'credit') {
      return { status: 'failed', reason: 'FrontLobbyScreeningAdapter only handles credit checks' };
    }
    const { fullName } = decodeProviderRef(providerRef);
    try {
      return await this.withBrowser(async (page) => {
        await page.goto(`${FRONTLOBBY_BASE_URL}/tenant-screening/reports`);
        await page.fill('input[placeholder="Search for applicant or property"]', fullName);
        const row = page.getByRole('row', { name: new RegExp(fullName, 'i') });
        if (await row.count() === 0) {
          return { status: 'pending', providerRef };
        }
        const statusText = (await row.first().textContent()) ?? '';
        // El texto real de "completado" en la columna Status no se pudo
        // observar (cuenta sin reportes generados aún) — se asume que
        // contiene "complete" o "ready", ajustar tras la primera corrida
        // real si el texto real difiere.
        if (!/complete|ready/i.test(statusText)) {
          return { status: 'pending', providerRef };
        }
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          row.first().getByRole('link', { name: /report|download/i }).click(),
        ]);
        const buffer = await (await download.createReadStream())?.toArray?.() ?? [];
        const pdfBuffer = Buffer.concat(buffer as Buffer[]);
        const base64 = pdfBuffer.toString('base64');
        const extraction = await this.glm.extractCreditReport({ mimeType: 'application/pdf', base64 });
        if (extraction.score === null) {
          return { status: 'failed', reason: 'Could not read credit score from report' };
        }
        return {
          status: 'completed',
          verdict: scoreToVerdict(extraction.score),
          summary: formatAutomatedSummary(extraction.score, extraction.aiSummaryText),
          reportBase64: base64,
          reportMimeType: 'application/pdf',
        };
      });
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : 'Unknown FrontLobby error' };
    }
  }
}
```

- [ ] **Step 8: Exportar la clase nueva desde el índice del paquete**

`packages/adapters/src/index.ts` re-exporta cada adapter real/mock con un
`export * from '...'` — `FrontLobbyScreeningAdapter` necesita la misma
entrada o Task 5 no podrá importarla desde `@property-manager/adapters`.
Agregar, junto a las demás líneas de `./real/*.js`:

```ts
export * from './real/front-lobby.real.js';
```

(`front-lobby.helpers.ts` NO necesita entrada aquí — solo lo consume
`front-lobby.real.ts` internamente y su propio test, vía import relativo.)

- [ ] **Step 9: Verificar compilación de todo el paquete**

```bash
pnpm --filter @property-manager/adapters exec tsc --noEmit
pnpm --filter @property-manager/adapters test
```

Expected: sin errores; toda la suite de `adapters` en verde (incluidos los tests nuevos de `front-lobby.helpers.test.ts` y `glm.mock.test.ts`).

- [ ] **Step 10: Commit**

```bash
git add packages/adapters/package.json packages/adapters/src/index.ts packages/adapters/src/contracts.ts packages/adapters/src/real/front-lobby.real.ts packages/adapters/src/real/front-lobby.helpers.ts packages/adapters/src/real/front-lobby.helpers.test.ts docs/PROJECT_HANDOFF.md
git commit -m "feat: FrontLobbyScreeningAdapter real (Playwright) — login, property, formulario, sondeo con OCR"
```

---

### Task 5: Enrutamiento real/mock + aprobación manual del cargo real

**Files:**
- Modify: `apps/api/src/services/screening.service.ts` (enrutamiento, `isSimulatedScreening`, `triggerScreeningIfConsented`)
- Modify: `apps/api/src/routes/leads.ts` (ruta nueva de aprobación)
- Test: `apps/api/src/services/screening.service.test.ts`
- Test: `apps/api/src/routes/leads.test.ts`

**Interfaces:**
- Consumes: `getIntegrationCredentials`/`ScreeningProvider` (`integration-vault.service.ts`, ya existe), `FrontLobbyScreeningAdapter` (Task 4), `GlmAdapter` vía `getAdapters().glm` (ya existe en el factory).
- Produces: ruta `POST /leads/applications/:applicationId/screening/:kind/approve` — consumida por Task 6 (UI).

- [ ] **Step 1: Escribir los tests que fallan — enrutamiento y aprobación**

En `apps/api/src/services/screening.service.test.ts`, agregar (junto a los describe blocks existentes, mismo patrón de `seed()`/`cleanup()` ya presente en el archivo):

```ts
import { saveIntegrationCredentials } from './integration-vault.service.js';

describe('triggerScreeningIfConsented — con FrontLobby real conectado', () => {
  it('deja creditCheckStatus en awaiting_approval y NO encola ningún job', async () => {
    const { applicationId } = await seed();
    await saveIntegrationCredentials({ tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p' });

    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('awaiting_approval');
    // criminal sigue siendo mock — comportamiento de hoy, sin cambios.
    expect(row.criminalCheckStatus).toBe('requested');
  });
});

describe('approveScreening', () => {
  it('transiciona awaiting_approval -> requested y devuelve ok', async () => {
    const { applicationId } = await seed();
    await saveIntegrationCredentials({ tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p' });
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const result = await approveScreening(applicationId, TENANT_ID, 'credit');

    expect(result).toEqual({ ok: true });
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('requested');
  });

  it('devuelve ok:false si el estado no es awaiting_approval (evita doble cobro)', async () => {
    const { applicationId } = await seed();
    const result = await approveScreening(applicationId, TENANT_ID, 'credit');
    expect(result).toEqual({ ok: false, reason: 'Not awaiting approval' });
  });
});
```

(Importar `approveScreening` desde `./screening.service.js` en el bloque de imports del archivo — el Step 3 lo exporta.)

- [ ] **Step 2: Correr y verificar que fallan**

```bash
pnpm --filter @property-manager/api exec vitest run screening.service.test.ts
```

Expected: FAIL — `approveScreening` no existe todavía; `triggerScreeningIfConsented` siempre encola sin importar la bóveda.

- [ ] **Step 3: Implementar el enrutamiento en `screening.service.ts`**

Agregar los imports nuevos al inicio del archivo:

```ts
import { getIntegrationCredentials, type ScreeningProvider } from './integration-vault.service.js';
import { FrontLobbyScreeningAdapter } from '@property-manager/adapters';
```

Reemplazar la función `isSimulatedScreening` (líneas 57-60) por el enrutamiento completo:

```ts
const PROVIDER_BY_KIND: Record<ScreeningCheckKind, ScreeningProvider> = {
  credit: 'frontlobby_portal',
  criminal: 'sterling_portal',
};

/**
 * Resuelve el adapter real por `kind` si el tenant tiene credenciales
 * conectadas en la bóveda; si no, cae al mock del factory global — el mismo
 * camino de hoy, sin cambios. Vive aquí (no en `factory.ts`/`getAdapters()`)
 * porque necesita leer la bóveda por tenant, y `getAdapters()` es síncrono
 * y cacheado una sola vez por proceso sin `tenantId` (ver Sección 4 del
 * spec de esta feature) — 64 call sites en el resto de la app dependen de
 * que siga siendo así.
 */
async function getScreeningAdapter(tenantId: string, kind: ScreeningCheckKind) {
  const credentials = await getIntegrationCredentials(tenantId, PROVIDER_BY_KIND[kind]);
  if (credentials && kind === 'credit') {
    const { getAdapters } = await import('../config/adapters.js');
    return new FrontLobbyScreeningAdapter(credentials, getAdapters().glm);
  }
  const { getAdapters } = await import('../config/adapters.js');
  return getAdapters().screening; // mock — Sterling real todavía no existe, credit sin credenciales cae aquí también
}

async function isMockScreening(tenantId: string, kind: ScreeningCheckKind): Promise<boolean> {
  const adapter = await getScreeningAdapter(tenantId, kind);
  return adapter.name === 'screening_mock';
}
```

Reemplazar los dos usos de `await isSimulatedScreening()` (en `persistTerminalResult`, línea 287, y en `notifyScreeningResult`, línea 344) por `await isMockScreening(tenantId, kind)` — ambas funciones ya reciben `tenantId` y `kind` como parámetros, no hace falta agregar nada a sus firmas.

Reemplazar los dos usos de `(await import('../config/adapters.js')).getAdapters().screening` en `runScreeningRequest` (línea 143-144) y `pollScreeningResult` (línea 180-181) por `await getScreeningAdapter(tenantId, kind)`.

En `runScreeningRequest`, el objeto que arma para `runCheck` (línea 144-151) gana los campos nuevos de Task 2/Task 4:

```ts
  const adapter = await getScreeningAdapter(tenantId, kind);
  const result = await adapter.runCheck(kind, {
    fullName: application.applicantFullName ?? '',
    firstName: application.applicantFirstName ?? '',
    lastName: application.applicantLastName ?? '',
    dateOfBirth: application.dateOfBirth?.toISOString().slice(0, 10) ?? '',
    currentAddress: application.currentAddress ?? '',
    currentCity: application.currentCity ?? '',
    currentProvince: application.currentProvince ?? '',
    currentPostalCode: application.currentPostalCode ?? '',
    currentAddressStartDate: application.currentAddressStartDateAt?.toISOString().slice(0, 10) ?? '',
  });
```

Reemplazar el cuerpo de `triggerScreeningIfConsented` (líneas 68-109) — el `update` inicial que marca ambos como `'requested'` pasa a decidir por `kind` si va a `'awaiting_approval'` (real) o `'requested'` (mock, como hoy), y el enqueue solo se dispara para los `kind` que sí quedaron en `'requested'`:

```ts
export async function triggerScreeningIfConsented(applicationId: string, tenantId: string): Promise<void> {
  const application = await prisma.rentalApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { consentCreditCheckAt: true, consentPoliceCheckAt: true },
  });
  if (!application || !application.consentCreditCheckAt || !application.consentPoliceCheckAt) return;

  const now = new Date();
  const kinds: ScreeningCheckKind[] = ['credit', 'criminal'];
  const initialStatusByKind = await Promise.all(
    kinds.map(async (kind) => ((await isMockScreening(tenantId, kind)) ? 'requested' : 'awaiting_approval') as const),
  );

  await prisma.rentalApplication.update({
    where: { id: applicationId },
    data: {
      creditCheckStatus: initialStatusByKind[0],
      creditCheckRequestedAt: now,
      criminalCheckStatus: initialStatusByKind[1],
      criminalCheckRequestedAt: now,
    },
  });

  const kindsToEnqueue = kinds.filter((_, index) => initialStatusByKind[index] === 'requested');
  const enqueued = await Promise.allSettled(
    kindsToEnqueue.map((kind) => screeningRequestQueue.add('run-screening-request', { tenantId, applicationId, kind })),
  );
  await Promise.all(
    enqueued.map(async (settled, index) => {
      if (settled.status === 'fulfilled') return;
      const kind = kindsToEnqueue[index]!;
      console.error(`[Screening] No se pudo encolar el checkeo de ${kind} para ${applicationId}:`, settled.reason);
      await persistTerminalResult(applicationId, tenantId, kind, {
        status: 'failed',
        reason: 'Could not schedule the screening check',
      });
    }),
  );

  const kindsAwaitingApproval = kinds.filter((_, index) => initialStatusByKind[index] === 'awaiting_approval');
  if (kindsAwaitingApproval.length > 0) {
    await notifyApprovalNeeded(applicationId, tenantId, kindsAwaitingApproval);
  }
}

/**
 * Best-effort, mismo patrón que `notifyScreeningResult`: el estado ya
 * quedó guardado como 'awaiting_approval', un fallo de notificación no
 * debe propagarse — el staff igual puede ver el botón de aprobar en
 * Showings sin haber recibido el aviso.
 */
async function notifyApprovalNeeded(applicationId: string, tenantId: string, kinds: ScreeningCheckKind[]): Promise<void> {
  try {
    const application = await prisma.rentalApplication.findFirstOrThrow({
      where: { id: applicationId, tenantId },
      include: { showing: { select: { brokerUserId: true } }, lead: { select: { assignedUserId: true, name: true } } },
    });
    const staff = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, email: true, role: true, notificationChannel: true, notificationAddress: true },
    });
    const targets: NotifiableStaff[] = resolveStaffNotifyTargets({
      brokerUserId: application.showing.brokerUserId,
      assignedUserId: application.lead.assignedUserId,
      staff,
      propertyManagerIds: staff.filter((member) => member.role === 'property_manager').map((member) => member.id),
    });
    const labels = kinds.map((kind) => (kind === 'credit' ? 'Credit check ($18.99)' : 'Criminal record check')).join(', ');
    const link = `${getEnv().WEB_URL}/showings`;
    const body = `${labels} for ${application.lead.name ?? 'a lead'} is ready to run — approve the real charge in Showings.\n\n${link}`;
    const { getAdapters } = await import('../config/adapters.js');
    await notifyStaffTargets({ targets, subject: 'Screening approval needed', body, messaging: getAdapters().messaging });
  } catch (error) {
    console.error(`[Screening] No se pudo notificar la aprobación pendiente de ${applicationId}:`, error);
  }
}

export async function approveScreening(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { count } = await prisma.rentalApplication.updateMany({
    where: { id: applicationId, tenantId, [STATUS_FIELD[kind]]: 'awaiting_approval' },
    data: { [STATUS_FIELD[kind]]: 'requested' },
  });
  if (count === 0) {
    return { ok: false, reason: 'Not awaiting approval' };
  }
  try {
    await screeningRequestQueue.add('run-screening-request', { tenantId, applicationId, kind });
  } catch (error) {
    console.error(`[Screening] No se pudo encolar el checkeo de ${kind} tras aprobación (${applicationId}):`, error);
    await persistTerminalResult(applicationId, tenantId, kind, {
      status: 'failed',
      reason: 'Could not schedule the screening check',
    });
  }
  return { ok: true };
}
```

- [ ] **Step 4: Correr y verificar que pasan**

```bash
pnpm --filter @property-manager/api exec vitest run screening.service.test.ts
```

Expected: PASS, tests nuevos y los ~existentes de este archivo.

- [ ] **Step 5: Ruta nueva de aprobación**

En `apps/api/src/routes/leads.ts`, la línea 21 hoy importa `requireAuth, requireUser` desde `../auth/context.js` (sin `requireRole`) y el archivo no importa nada de `screening.service.js` todavía. Reemplazar la línea 21 por:

```ts
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
```

Y agregar, junto al resto de imports de servicios (cerca de la línea 30):

```ts
import { approveScreening } from '../services/screening.service.js';
```

`requireRole(...roles: UserRole[])` (confirmado en `apps/api/src/auth/context.ts:44`) ya acepta varios roles como argumentos separados — `requireRole('property_manager', 'broker')` es válido tal cual.

Junto a la ruta existente `GET /applications/:applicationId/report/:kind` (línea 674), agregar la ruta nueva:

```ts
leadsRouter.post(
  '/applications/:applicationId/screening/:kind/approve',
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
      const result = await approveScreening(applicationId, user.tenantId, kind);
      if (!result.ok) {
        res.status(409).json({ error: result.reason });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 6: Test de la ruta**

En `apps/api/src/routes/leads.test.ts`, agregar (mismo patrón de request HTTP real que el resto del archivo — revisar un test existente de ese archivo para el helper de request/auth que usa):

```ts
it('POST /applications/:id/screening/:kind/approve transiciona awaiting_approval a requested', async () => {
  // seed de una aplicación con creditCheckStatus: 'awaiting_approval' —
  // seguir el patrón de seed ya usado por los tests vecinos de este archivo
  const res = await request(app)
    .post(`/leads/applications/${applicationId}/screening/credit/approve`)
    .set('Authorization', `Bearer ${propertyManagerToken}`);
  expect(res.status).toBe(200);
});

it('devuelve 409 si el estado no es awaiting_approval', async () => {
  const res = await request(app)
    .post(`/leads/applications/${applicationId}/screening/credit/approve`)
    .set('Authorization', `Bearer ${propertyManagerToken}`);
  expect(res.status).toBe(409);
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
git commit -m "feat: enrutar screening real/mock por tenant, aprobación manual del cargo real de FrontLobby"
```

---

### Task 6: UI — botón de aprobación en Showings

**Files:**
- Modify: `apps/web/src/pages/ShowingsPage.tsx` (`ApplicationDetail`, `SCREENING_STATUS_META`, `ScreeningBlock`)

**Interfaces:**
- Consumes: ruta `POST /leads/applications/:applicationId/screening/:kind/approve` (Task 5).

- [ ] **Step 1: Agregar el estado nuevo al mapa de metadatos**

En `apps/web/src/pages/ShowingsPage.tsx`, en `SCREENING_STATUS_META` (línea 56), agregar:

```ts
const SCREENING_STATUS_META: Record<string, { label: string; color: string }> = {
  awaiting_approval: { label: 'Needs approval', color: 'bg-blue-100 text-blue-800' },
  requested: { label: 'Requested', color: 'bg-slate-100 text-slate-600' },
  pending: { label: 'Pending', color: 'bg-slate-100 text-slate-600' },
  passed: { label: 'Passed', color: 'bg-green-100 text-green-800' },
  flagged: { label: 'Flagged', color: 'bg-amber-100 text-amber-800' },
  failed: { label: 'Failed', color: 'bg-red-100 text-red-800' },
};
```

- [ ] **Step 2: Botón de aprobación en `ScreeningBlock`**

En `ScreeningBlock` (línea 125), agregar el hook de auth y la mutación de aprobación, y renderizar el botón cuando `status === 'awaiting_approval'` y el usuario tiene el rol correcto:

```tsx
function ScreeningBlock({
  label,
  applicationId,
  kind,
  status,
  summary,
  reportKey,
}: {
  label: string;
  applicationId: string;
  kind: 'credit' | 'criminal';
  status: string | null | undefined;
  summary: string | null | undefined;
  reportKey: string | null | undefined;
}) {
  const { user } = useAuth();
  const canApprove = user?.role === 'property_manager' || user?.role === 'broker';
  const queryClient = useQueryClient();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const meta = status ? SCREENING_STATUS_META[status] : null;
  const showSummary = summary && status !== 'requested' && status !== 'pending' && status !== 'awaiting_approval';

  const approve = useMutation({
    mutationFn: () => apiFetch(`/leads/applications/${applicationId}/screening/${kind}/approve`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['showing-application'] }),
  });

  // ... handleDownload sin cambios ...

  return (
    <div>
      <div className="flex items-center justify-between">
        <span>{label}</span>
        {meta ? (
          <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] ${meta.color}`}>{meta.label}</span>
        ) : (
          <span className="text-slate-400">Not requested</span>
        )}
      </div>
      {status === 'awaiting_approval' && canApprove && (
        <button
          type="button"
          onClick={() => approve.mutate()}
          disabled={approve.isPending}
          className="mt-0.5 rounded-md bg-teal-600 px-2 py-1 text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {approve.isPending ? 'Approving…' : `Approve $18.99 charge and run ${label.toLowerCase()}`}
        </button>
      )}
      {approve.isError && <p className="mt-0.5 text-red-600">Could not approve — try again.</p>}
      {showSummary && <p className="mt-0.5 text-slate-600">{summary}</p>}
      {reportKey && (
        <button type="button" onClick={handleDownload} disabled={isDownloading} className="mt-0.5 text-teal-600 hover:underline disabled:opacity-50">
          {isDownloading ? 'Opening report…' : 'Download full report'}
        </button>
      )}
      {downloadError && <p className="mt-0.5 text-red-600">{downloadError}</p>}
    </div>
  );
}
```

(El botón de aprobación solo se muestra para `credit` en la práctica hoy — `criminal` sigue siendo mock y nunca llega a `'awaiting_approval'` — pero el componente no necesita distinguir `kind` para esto, ya lo maneja el backend.)

- [ ] **Step 3: Verificar compilación y suite**

```bash
pnpm --filter @property-manager/web exec tsc --noEmit
pnpm --filter @property-manager/web test
```

Expected: sin errores; los 2 tests existentes de `web` en verde (no hay tests de componente para `ShowingsPage.tsx` hoy — consistente con la convención ya establecida en tareas anteriores de esta fase).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/ShowingsPage.tsx
git commit -m "feat: botón de aprobación del cargo real de FrontLobby en Showings"
```

---

### Task 7: Roadmap y regresión completa

**Files:**
- Modify: `docs/PRODUCT_ROADMAP.md` (sección 2.2)

- [ ] **Step 1: Actualizar el roadmap**

En `docs/PRODUCT_ROADMAP.md`, sección 2.2, actualizar el bloque de "Nivel 2 — browser automation" para reflejar: el checkeo de **crédito** ya corre real contra FrontLobby (Playwright, con aprobación manual del cargo de $18.99 y notificación al staff); antecedentes penales sigue en mock hasta que exista cuenta de Sterling; los valores exactos de la columna Status de `/tenant-screening/reports` y el selector de descarga en estado completado quedan pendientes de confirmar en la primera corrida real (ver `docs/superpowers/specs/2026-08-13-fase-2-2-frontlobby-real-adapter-design.md`, Sección 7).

- [ ] **Step 2: Regresión completa del monorepo**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Expected: todo verde en los 4 paquetes. Si algo falla, no commitear: reportar BLOCKED.

- [ ] **Step 3: Commit**

```bash
git add docs/PRODUCT_ROADMAP.md
git commit -m "docs: FrontLobby real (crédito) entregado en el roadmap"
```

---

## Notas para quien ejecute el plan

- **La navegación real de Playwright (Task 4) no tiene test automatizado** — ver la nota dentro del task. Esto es un límite real del dominio (no hay sandbox de FrontLobby), no un hueco de calidad del plan. La red de seguridad es la aprobación manual (Task 5): nada corre contra la cuenta real sin que un humano apruebe el gasto, así que un selector equivocado falla como `'failed'` con el error real, nunca silenciosamente ni con un veredicto inventado.
- **Antes de dar por cerrada la Task 4**, el revisor debe confirmar que `front-lobby.helpers.ts` tiene cobertura real (son las únicas partes de ese task que SÍ se pueden probar) y que `front-lobby.real.ts` maneja todo error como `'failed'`, nunca deja un `throw` sin capturar que reviente el worker.
- **El umbral de score (`CREDIT_SCORE_PASS_THRESHOLD = 620`) es una constante hardcoded a propósito** (Sección 8 del spec, decisión explícita del usuario) — no convertirlo en configuración por tenant sin que se pida.

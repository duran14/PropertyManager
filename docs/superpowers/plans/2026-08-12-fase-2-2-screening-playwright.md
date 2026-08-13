# Fase 2.2 (nivel 2) — Screening vía automatización de navegador: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correr de verdad los dos checkeos de screening (crédito vía FrontLobby, antecedentes penales vía Sterling) que hoy solo capturan consentimiento y no hacen nada, usando automatización de navegador contra el portal web de cada proveedor con las credenciales de la propia agencia.

**Architecture:** Un contrato `ScreeningAdapter` agnóstico de mecanismo (`runCheck`/`pollResult`) detrás del cual vive un `ScreeningMockAdapter` (desarrollo/pruebas) y, más adelante, `PlaywrightScreeningAdapter` (bloqueado hasta que exista cuenta real con los proveedores — Tarea 6). El disparo es automático al enviar la solicitud de renta si ambos consentimientos existen; el resultado se sondea con un job de BullMQ porque un checkeo real casi nunca es instantáneo. Le da su primer uso real al modelo `IntegrationConfig`, que existe en el schema desde el MVP y nunca se conectó a nada.

**Tech Stack:** TypeScript, Node 20, Express, Prisma + PostgreSQL, Zod, BullMQ + Redis, Vitest, React + Vite + TanStack Query. `@playwright/test` es la única dependencia nueva de todo este proyecto — no hay forma de automatizar un navegador con `fetch` puro.

**Spec:** [`docs/superpowers/specs/2026-08-12-fase-2-2-screening-playwright-design.md`](../specs/2026-08-12-fase-2-2-screening-playwright-design.md)

## Global Constraints

1. **Nunca reportar como hecho algo que no ocurrió.** Login fallido, selector roto, timeout, o CAPTCHA/2FA inesperado → siempre `status: 'failed'` con aviso al staff, nunca un resultado inventado.
2. **Credenciales cifradas en reposo**, con `encrypt()`/`decrypt()` de `apps/api/src/config/crypto.ts` (AES-256-GCM). Nunca en texto plano, nunca en logs, nunca en payloads de auditoría. La contraseña nunca se devuelve al frontend una vez guardada.
3. **Aislamiento por tenant.** Toda consulta filtra por `tenantId`.
4. **Errores por valor de retorno, no por excepción**, donde aplique — el manejador global de `app.ts` convierte cualquier `throw` en 500.
5. **El repo se queda verde.**
6. **`@playwright/test` (o `playwright`) es la única excepción documentada a "cero dependencias nuevas"** en todo este proyecto.
7. **El asistente nunca introduce contraseñas del usuario en un formulario ni inicia sesión en su nombre.** La Tarea 6 (selectores reales del portal) queda bloqueada por esta razón, no por descuido — ver esa tarea para instrucciones exactas.

### Seguridad de la base de datos — leer antes de tocar Prisma

- **NUNCA** ejecutar `prisma migrate reset`, `prisma db push`, ni `migrate dev --force-reset`.
- **NUNCA** pasar `$DATABASE_URL` como `--shadow-database-url`.
- El comando de migración es exactamente:
  ```bash
  pnpm --filter @property-manager/api exec prisma migrate dev --name <nombre>
  ```
- Si `prisma migrate dev` no corre de forma no interactiva en este entorno (ya pasó una vez en este mismo worktree, ver `.superpowers/sdd/2026-08-08-fase-2a-post-showing-application/task-1-report.md` si aún existe, o el patrón documentado en fases anteriores): usar `prisma migrate diff` (contra el propio datasource del schema, nunca con `--shadow-database-url`) para generar el SQL, colocarlo a mano en una carpeta de migración con el timestamp correcto, y aplicar con `prisma migrate deploy` (aditivo, sin `--force`, sin `--accept-data-loss`).

### Comandos de verificación

```bash
pnpm -r exec tsc --noEmit
pnpm --filter @property-manager/api test
pnpm --filter @property-manager/web test
pnpm -r run test   # regresión completa, última tarea
```

### Convenciones del repo

- Comentarios en español explicando el porqué, código y nombres en inglés.
- Los adapters reales reciben sus dependencias externas por constructor para poder simularlas en pruebas.
- Las pruebas de servicio corren contra la base real, con `cleanup()`/`seed()` propios y un `TENANT_ID` del archivo — ver `apps/api/src/services/rental-application.service.test.ts` como referencia directa (mismo dominio: `RentalApplication`).

---

## Estructura de archivos

**Crear:**

| Archivo | Responsabilidad |
|---|---|
| `packages/adapters/src/mocks/screening.mock.ts` | `ScreeningMockAdapter` determinista |
| `packages/adapters/src/real/screening-playwright.real.ts` | Esqueleto de `PlaywrightScreeningAdapter` — login/navegación reales quedan pendientes (Tarea 6) |
| `apps/api/src/services/integration-vault.service.ts` | Guardar/leer/probar credenciales de `IntegrationConfig` |
| `apps/api/src/services/screening.service.ts` | Disparo, orquestación de jobs, persistencia de resultado |
| `apps/api/src/routes/integrations.ts` | Rutas de la bóveda de credenciales |
| `apps/web/src/pages/IntegrationsPage.tsx` | Pantalla de credenciales de FrontLobby/Sterling |

**Modificar:**

| Archivo | Cambio |
|---|---|
| `apps/api/prisma/schema.prisma` | Campos de identidad + resultado en `RentalApplication`; comentario de `provider` en `IntegrationConfig` |
| `packages/adapters/src/contracts.ts` | Contrato `ScreeningAdapter` y sus tipos |
| `packages/adapters/src/factory.ts` | Campo `screening` en `Adapters` |
| `apps/api/src/jobs/queues.ts` | `screeningRequestQueue`, `screeningPollQueue` |
| `apps/api/src/jobs/worker.ts` | Workers de las dos colas nuevas |
| `apps/api/src/services/rental-application.service.ts` | `submitRentalApplication` gana los campos nuevos y dispara el screening |
| `apps/api/src/routes/leads.ts` | El body del `POST /public/applications/:token` acepta los campos nuevos |
| `apps/web/src/pages/ApplyPage.tsx` | Campos de fecha de nacimiento y dirección |
| `apps/web/src/App.tsx` | Ruta `/integrations` |
| `apps/web/src/components/Layout.tsx` | Entrada de menú "Integrations" |
| `apps/web/src/pages/ShowingsPage.tsx` | Sección de resultado de screening en la aplicación |
| `apps/web/src/lib/types.ts` | Tipos de la aplicación extendidos |
| `docs/PRODUCT_ROADMAP.md` | Marcar §2.2 nivel 2 entregado, niveles 1/3 pendientes |

---

## Task 1: Esquema — identidad, resultado del screening, y la bóveda

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_screening_result/migration.sql` (la genera Prisma)

**Interfaces:**
- Consumes: nada.
- Produces: campos nuevos en `RentalApplication` (`dateOfBirth`, `currentAddress`, `currentCity`, `currentProvince`, `currentPostalCode`, `creditCheckStatus`, `creditCheckSummary`, `creditCheckReportKey`, `creditCheckProviderRef`, `creditCheckRequestedAt`, `creditCheckCompletedAt`, y el mismo set con prefijo `criminalCheck`); comentario actualizado de `IntegrationConfig.provider`.

- [ ] **Step 1: Agregar los campos a `RentalApplication`**

En `apps/api/prisma/schema.prisma`, dentro de `model RentalApplication`, junto a `idDocumentStorageKey`:

```prisma
  // Fase 2.2: identidad requerida para el screening de crédito/antecedentes
  // — sin esto ni FrontLobby ni Sterling pueden identificar a la persona.
  dateOfBirth        DateTime?
  currentAddress     String?
  currentCity        String?
  currentProvince    String?
  currentPostalCode  String?

  // Resultado del checkeo de crédito (FrontLobby). Cada checkeo tiene su
  // propio ciclo de vida — pueden completarse en momentos distintos.
  creditCheckStatus      String?   // requested | pending | passed | flagged | failed
  creditCheckSummary     String?
  creditCheckReportKey   String?
  creditCheckProviderRef String?
  creditCheckRequestedAt DateTime?
  creditCheckCompletedAt DateTime?

  // Resultado del checkeo de antecedentes penales (Sterling, CPIC).
  criminalCheckStatus      String?
  criminalCheckSummary     String?
  criminalCheckReportKey   String?
  criminalCheckProviderRef String?
  criminalCheckRequestedAt DateTime?
  criminalCheckCompletedAt DateTime?
```

- [ ] **Step 2: Actualizar el comentario de `IntegrationConfig.provider`**

En `model IntegrationConfig`, cambiar:

```prisma
  provider              String // buildium | qbo | twilio | plaid | stripe
```

por:

```prisma
  provider              String // buildium | qbo | twilio | plaid | stripe | frontlobby_portal | sterling_portal
```

Es un `String` libre, no un enum — este cambio es solo de comentario, no de tipo.

- [ ] **Step 3: Generar la migración**

```bash
pnpm --filter @property-manager/api exec prisma migrate dev --name add_screening_result
```

- [ ] **Step 4: Verificar el SQL generado**

```bash
grep -E "ADD COLUMN|DROP" apps/api/prisma/migrations/*_add_screening_result/migration.sql
```

Esperado: solo `ALTER TABLE "rental_applications" ADD COLUMN ...` (16 columnas nuevas), ningún `DROP`.

- [ ] **Step 5: Typecheck y commit**

```bash
pnpm -r exec tsc --noEmit
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat: schema de identidad y resultado del screening"
```

---

## Task 2: El contrato `ScreeningAdapter` y su mock

**Files:**
- Modify: `packages/adapters/src/contracts.ts`
- Create: `packages/adapters/src/mocks/screening.mock.ts`
- Create: `packages/adapters/src/mocks/screening.mock.test.ts`
- Modify: `packages/adapters/src/factory.ts`
- Test: `packages/adapters/src/factory.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `ScreeningApplicantInput`, `ScreeningCheckKind`, `ScreeningRunResult`, `ScreeningAdapter`, `ScreeningMockAdapter`, `Adapters.screening`.

- [ ] **Step 1: Agregar el contrato**

En `packages/adapters/src/contracts.ts`, al final:

```ts
// -----------------------------------------------------------------------------
// Screening — checkeo de crédito y antecedentes penales de un solicitante.
//
// Agnóstico de proveedor y de mecanismo: el mismo contrato sirve para
// automatización de navegador (esta fase), y para una API real o un flujo
// de PDF+OCR si algún día existen, sin que el resto del sistema cambie.
// -----------------------------------------------------------------------------

export interface ScreeningApplicantInput {
  fullName: string;
  dateOfBirth: string; // ISO date (YYYY-MM-DD)
  currentAddress: string;
  currentCity: string;
  currentProvince: string;
  currentPostalCode: string;
  email?: string;
  phone?: string;
}

export type ScreeningCheckKind = 'credit' | 'criminal';

export type ScreeningRunResult =
  | {
    status: 'completed';
    verdict: 'passed' | 'flagged';
    summary: string;
    reportBase64: string;
    reportMimeType: string;
  }
  | { status: 'pending'; providerRef: string }
  | { status: 'failed'; reason: string };

export interface ScreeningAdapter {
  readonly name: 'screening_mock' | 'screening_playwright';
  /** Envía la solicitud. Un mecanismo de navegador casi siempre devuelve 'pending'. */
  runCheck(kind: ScreeningCheckKind, input: ScreeningApplicantInput): Promise<ScreeningRunResult>;
  /** Revisa si un envío 'pending' ya tiene resultado. */
  pollResult(kind: ScreeningCheckKind, providerRef: string): Promise<ScreeningRunResult>;
}
```

- [ ] **Step 2: Escribir las pruebas del mock**

Crear `packages/adapters/src/mocks/screening.mock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ScreeningMockAdapter } from './screening.mock.js';

const APPLICANT = {
  fullName: 'Ana Prospect',
  dateOfBirth: '1990-05-15',
  currentAddress: '123 Test St',
  currentCity: 'Vancouver',
  currentProvince: 'British Columbia',
  currentPostalCode: 'V6B 1A1',
};

describe('ScreeningMockAdapter', () => {
  it('devuelve pending al enviar, luego completed al sondear', async () => {
    const adapter = new ScreeningMockAdapter();
    const sent = await adapter.runCheck('credit', APPLICANT);
    expect(sent.status).toBe('pending');
    if (sent.status !== 'pending') return;

    const polled = await adapter.pollResult('credit', sent.providerRef);
    expect(polled.status).toBe('completed');
    if (polled.status !== 'completed') return;
    expect(['passed', 'flagged']).toContain(polled.verdict);
    expect(polled.reportMimeType).toBe('application/pdf');
  });

  it('sondear una referencia desconocida devuelve failed', async () => {
    const adapter = new ScreeningMockAdapter();
    const result = await adapter.pollResult('criminal', 'no_existe');
    expect(result.status).toBe('failed');
  });

  it('el nombre "flagged" en el nombre completo produce un veredicto flagged determinista', async () => {
    // Para que las pruebas de servicio puedan ejercitar la rama "flagged"
    // sin depender de aleatoriedad.
    const adapter = new ScreeningMockAdapter();
    const sent = await adapter.runCheck('criminal', { ...APPLICANT, fullName: 'Flagged Applicant' });
    if (sent.status !== 'pending') throw new Error('se esperaba pending');
    const polled = await adapter.pollResult('criminal', sent.providerRef);
    if (polled.status !== 'completed') throw new Error('se esperaba completed');
    expect(polled.verdict).toBe('flagged');
  });
});
```

- [ ] **Step 3: Implementar el mock**

Crear `packages/adapters/src/mocks/screening.mock.ts`:

```ts
/**
 * Mock determinista de screening. Cualquier solicitante cuyo `fullName`
 * contenga "Flagged" (sin importar mayúsculas) produce un veredicto
 * `flagged` — así las pruebas de servicio pueden ejercitar esa rama sin
 * depender de aleatoriedad. Todo lo demás produce `passed`.
 */
import type {
  ScreeningAdapter,
  ScreeningApplicantInput,
  ScreeningCheckKind,
  ScreeningRunResult,
} from '../contracts.js';

export class ScreeningMockAdapter implements ScreeningAdapter {
  readonly name = 'screening_mock' as const;

  private pending = new Map<string, { kind: ScreeningCheckKind; applicant: ScreeningApplicantInput }>();
  private counter = 0;

  async runCheck(kind: ScreeningCheckKind, input: ScreeningApplicantInput): Promise<ScreeningRunResult> {
    const providerRef = `mock_${kind}_${++this.counter}`;
    this.pending.set(providerRef, { kind, applicant: input });
    return { status: 'pending', providerRef };
  }

  async pollResult(kind: ScreeningCheckKind, providerRef: string): Promise<ScreeningRunResult> {
    const entry = this.pending.get(providerRef);
    if (!entry || entry.kind !== kind) {
      return { status: 'failed', reason: 'Unknown provider reference' };
    }
    const flagged = entry.applicant.fullName.toLowerCase().includes('flagged');
    return {
      status: 'completed',
      verdict: flagged ? 'flagged' : 'passed',
      summary: flagged
        ? `${kind === 'credit' ? 'Score 480' : '1 prior record found'} — review recommended`
        : `${kind === 'credit' ? 'Score 740, no collections' : 'No criminal record found'}`,
      reportBase64: Buffer.from(`Mock ${kind} report for ${entry.applicant.fullName}`).toString('base64'),
      reportMimeType: 'application/pdf',
    };
  }
}
```

- [ ] **Step 4: Cablear el factory**

En `packages/adapters/src/factory.ts`: importar `ScreeningAdapter` de `./contracts.js` y `ScreeningMockAdapter` de `./mocks/screening.mock.js`. Agregar `screening: ScreeningAdapter;` a la interfaz `Adapters`. Construirlo — hasta que exista el real (Tarea 6), siempre el mock:

```ts
  // El adapter real (Playwright) llega cuando exista cuenta con los
  // proveedores — hasta entonces el mock cubre desarrollo y pruebas.
  const screening: ScreeningAdapter = new ScreeningMockAdapter();
```

Agregar `screening` al objeto `Adapters` devuelto. **No** se agrega a `mockModes` — a diferencia de las demás integraciones, `screening` no tiene una variante real seleccionable por env todavía (eso es la Tarea 6), así que no aplica el patrón `isIntegrationConfigured`.

- [ ] **Step 5: Prueba del factory**

Agregar a `packages/adapters/src/factory.test.ts`:

```ts
it('expone un adapter de screening', () => {
  const adapters = createAdapters(baseEnv);
  expect(adapters.screening.name).toBe('screening_mock');
});
```

- [ ] **Step 6: Correr y verificar**

```bash
pnpm --filter @property-manager/adapters test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src
git commit -m "feat: contrato ScreeningAdapter y mock determinista"
```

---

## Task 3: La bóveda de credenciales — `integration-vault.service.ts`

**Files:**
- Create: `apps/api/src/services/integration-vault.service.ts`
- Create: `apps/api/src/services/integration-vault.service.test.ts`
- Create: `apps/api/src/routes/integrations.ts`
- Create: `apps/api/src/routes/integrations.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` de `apps/api/src/config/crypto.ts` (ya existen); `requireAuth`/`requireRole`/`requireUser` de `apps/api/src/auth/context.ts`.
- Produces:
  - `type ScreeningProvider = 'frontlobby_portal' | 'sterling_portal'`
  - `function saveIntegrationCredentials(input: { tenantId: string; provider: ScreeningProvider; username: string; password: string }): Promise<void>`
  - `function getIntegrationCredentials(tenantId: string, provider: ScreeningProvider): Promise<{ username: string; password: string } | null>`
  - `function markIntegrationStatus(tenantId: string, provider: ScreeningProvider, status: 'connected' | 'error'): Promise<void>`
  - `function listIntegrationStatuses(tenantId: string): Promise<Array<{ provider: ScreeningProvider; status: string; lastSyncedAt: Date | null }>>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/api/src/services/integration-vault.service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import {
  getIntegrationCredentials,
  listIntegrationStatuses,
  markIntegrationStatus,
  saveIntegrationCredentials,
} from './integration-vault.service.js';

const TENANT_ID = 'tenant_test_integration_vault';

async function cleanup() {
  await prisma.integrationConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Vault Test', province: 'BC' } });
});

afterEach(cleanup);

describe('saveIntegrationCredentials / getIntegrationCredentials', () => {
  it('guarda cifrado y lo devuelve descifrado', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID,
      provider: 'frontlobby_portal',
      username: 'agency@example.com',
      password: 'super-secret-pw',
    });

    const row = await prisma.integrationConfig.findFirstOrThrow({
      where: { tenantId: TENANT_ID, provider: 'frontlobby_portal' },
    });
    expect(row.encryptedCredentials).not.toContain('super-secret-pw');
    expect(row.status).toBe('pending');

    const creds = await getIntegrationCredentials(TENANT_ID, 'frontlobby_portal');
    expect(creds).toEqual({ username: 'agency@example.com', password: 'super-secret-pw' });
  });

  it('devuelve null si no hay credenciales guardadas', async () => {
    expect(await getIntegrationCredentials(TENANT_ID, 'sterling_portal')).toBeNull();
  });

  it('guardar de nuevo reemplaza la credencial anterior, no crea una fila nueva', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'a@example.com', password: 'pw1',
    });
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'b@example.com', password: 'pw2',
    });

    const rows = await prisma.integrationConfig.findMany({
      where: { tenantId: TENANT_ID, provider: 'frontlobby_portal' },
    });
    expect(rows).toHaveLength(1);
    expect(await getIntegrationCredentials(TENANT_ID, 'frontlobby_portal'))
      .toEqual({ username: 'b@example.com', password: 'pw2' });
  });
});

describe('markIntegrationStatus', () => {
  it('actualiza el estado y lastSyncedAt', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'sterling_portal', username: 'u', password: 'p',
    });
    await markIntegrationStatus(TENANT_ID, 'sterling_portal', 'connected');

    const row = await prisma.integrationConfig.findFirstOrThrow({
      where: { tenantId: TENANT_ID, provider: 'sterling_portal' },
    });
    expect(row.status).toBe('connected');
    expect(row.lastSyncedAt).not.toBeNull();
  });
});

describe('listIntegrationStatuses', () => {
  it('lista sin exponer credenciales', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p',
    });
    const list = await listIntegrationStatuses(TENANT_ID);
    expect(list).toEqual([
      { provider: 'frontlobby_portal', status: 'pending', lastSyncedAt: null },
    ]);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- integration-vault
```

- [ ] **Step 3: Implementar el servicio**

Crear `apps/api/src/services/integration-vault.service.ts`:

```ts
/**
 * Bóveda de credenciales de terceros — le da su primer uso real a
 * IntegrationConfig, que existe en el schema desde el MVP y nunca se
 * conectó a nada. Usuario/contraseña se guardan como un JSON cifrado de
 * una sola pieza; nunca se devuelven en claro a ningún endpoint HTTP
 * (getIntegrationCredentials es solo para uso interno del servidor).
 */
import { prisma } from '../config/db.js';
import { decrypt, encrypt } from '../config/crypto.js';

export type ScreeningProvider = 'frontlobby_portal' | 'sterling_portal';

interface VaultCredentials {
  username: string;
  password: string;
}

export async function saveIntegrationCredentials(input: {
  tenantId: string;
  provider: ScreeningProvider;
  username: string;
  password: string;
}): Promise<void> {
  const payload: VaultCredentials = { username: input.username, password: input.password };
  await prisma.integrationConfig.upsert({
    where: { tenantId_provider: { tenantId: input.tenantId, provider: input.provider } },
    update: { encryptedCredentials: encrypt(JSON.stringify(payload)), status: 'pending' },
    create: {
      tenantId: input.tenantId,
      provider: input.provider,
      encryptedCredentials: encrypt(JSON.stringify(payload)),
      status: 'pending',
    },
  });
}

export async function getIntegrationCredentials(
  tenantId: string,
  provider: ScreeningProvider,
): Promise<VaultCredentials | null> {
  const row = await prisma.integrationConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider } },
  });
  if (!row) return null;
  return JSON.parse(decrypt(row.encryptedCredentials)) as VaultCredentials;
}

export async function markIntegrationStatus(
  tenantId: string,
  provider: ScreeningProvider,
  status: 'connected' | 'error',
): Promise<void> {
  await prisma.integrationConfig.updateMany({
    where: { tenantId, provider },
    data: { status, lastSyncedAt: new Date() },
  });
}

export async function listIntegrationStatuses(
  tenantId: string,
): Promise<Array<{ provider: ScreeningProvider; status: string; lastSyncedAt: Date | null }>> {
  const rows = await prisma.integrationConfig.findMany({
    where: { tenantId, provider: { in: ['frontlobby_portal', 'sterling_portal'] } },
    select: { provider: true, status: true, lastSyncedAt: true },
  });
  return rows.map((row) => ({ provider: row.provider as ScreeningProvider, status: row.status, lastSyncedAt: row.lastSyncedAt }));
}
```

**Confirmado contra el schema real:** `IntegrationConfig` ya declara
`@@unique([tenantId, provider])` (verificado antes de escribir esta
tarea) — el `upsert` con `where: { tenantId_provider: {...} }` compila
sin necesitar ninguna migración nueva.

- [ ] **Step 4: Correr y verificar**

```bash
pnpm --filter @property-manager/api test -- integration-vault
```

- [ ] **Step 5: Las rutas**

Crear `apps/api/src/routes/integrations.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import {
  listIntegrationStatuses,
  saveIntegrationCredentials,
  type ScreeningProvider,
} from '../services/integration-vault.service.js';

export const integrationsRouter = Router();

const SCREENING_PROVIDERS: ScreeningProvider[] = ['frontlobby_portal', 'sterling_portal'];

const saveSchema = z.object({
  provider: z.enum(['frontlobby_portal', 'sterling_portal']),
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

integrationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const statuses = await listIntegrationStatuses(user.tenantId);
    // Siempre se listan los dos proveedores conocidos, con 'not_configured'
    // para el que todavía no tiene fila — así la UI no tiene que inferir
    // ausencia de configuración.
    const byProvider = new Map(statuses.map((entry) => [entry.provider, entry]));
    res.json({
      integrations: SCREENING_PROVIDERS.map((provider) => byProvider.get(provider) ?? {
        provider, status: 'not_configured', lastSyncedAt: null,
      }),
    });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.post('/', requireAuth, requireRole('property_manager'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid credentials payload' });
      return;
    }
    await saveIntegrationCredentials({ tenantId: user.tenantId, ...parsed.data });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Montar el router**

En `apps/api/src/app.ts`, importar `integrationsRouter` y montarlo:

```ts
  app.use('/integrations', integrationsRouter);
```

Verificar que no choca con el router `/integrations/google-calendar` de la Fase 1.3 — si ese ya está montado como su propio sub-path, este monta en la raíz `/integrations` y Express despacha por el método+path exacto sin conflicto (uno es `/integrations/google-calendar/...`, este es `/integrations` y `/integrations` con verbos GET/POST). Si el orden de montaje importa por algún prefijo compartido, verificar contra el código real de `app.ts` antes de asumir que no hay conflicto.

- [ ] **Step 7: Pruebas de las rutas**

Crear `apps/api/src/routes/integrations.test.ts` con pruebas directas del handler (mismo patrón sin `supertest` que el resto del repo — llamar la lógica de negocio directo, ya cubierta en el Step 1; para las rutas, verificar como mínimo que `requireRole('property_manager')` está en la cadena de middleware de `POST /` vía grep del archivo, consistente con el patrón ya usado en tareas anteriores de este proyecto para rutas sin infraestructura de test HTTP).

- [ ] **Step 8: Correr y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/integration-vault.service.ts apps/api/src/services/integration-vault.service.test.ts apps/api/src/routes/integrations.ts apps/api/src/routes/integrations.test.ts apps/api/src/app.ts apps/api/prisma
git commit -m "feat: bóveda de credenciales para FrontLobby/Sterling"
```

---

## Task 4: Disparo automático y jobs de screening

**Files:**
- Modify: `apps/api/src/jobs/queues.ts`
- Modify: `apps/api/src/jobs/worker.ts`
- Create: `apps/api/src/services/screening.service.ts`
- Create: `apps/api/src/services/screening.service.test.ts`
- Modify: `apps/api/src/services/rental-application.service.ts`

**Interfaces:**
- Consumes: `ScreeningAdapter`/`ScreeningCheckKind`/`ScreeningRunResult` (Tarea 2); `getIntegrationCredentials` (Tarea 3, no se usa todavía en el mock pero el servicio ya prepara el punto de conexión); `getAdapters().screening`; `notifyStaffTargets`/`resolveStaffNotifyTargets` (Fase 1.2/2A); `document-storage.service.ts` (`createLocalDocumentStorage`, `buildDocumentStorageKey`, ya usados en `rental-application.service.ts`).
- Produces:
  - `function triggerScreeningIfConsented(applicationId: string, tenantId: string): Promise<void>`
  - `function runScreeningRequest(applicationId: string, tenantId: string, kind: ScreeningCheckKind): Promise<void>`
  - `function pollScreeningResult(applicationId: string, tenantId: string, kind: ScreeningCheckKind, providerRef: string): Promise<{ done: boolean }>`

- [ ] **Step 1: Las colas**

En `apps/api/src/jobs/queues.ts`, agregar a `QUEUE_NAMES`:

```ts
  screeningRequest: 'screening-request',
  screeningPoll: 'screening-poll',
```

Y las colas nuevas, siguiendo el patrón de `remarketingQueue`:

```ts
export interface ScreeningRequestJobData {
  tenantId: string;
  applicationId: string;
  kind: ScreeningCheckKind;
}

export const screeningRequestQueue = new Queue<ScreeningRequestJobData, unknown, string>(
  QUEUE_NAMES.screeningRequest,
  {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 20 },
    },
  },
);

export interface ScreeningPollJobData {
  tenantId: string;
  applicationId: string;
  kind: ScreeningCheckKind;
  providerRef: string;
}

export const screeningPollQueue = new Queue<ScreeningPollJobData, unknown, string>(
  QUEUE_NAMES.screeningPoll,
  {
    connection: redis,
    defaultJobOptions: {
      attempts: 10,
      backoff: { type: 'fixed', delay: 15 * 60_000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 20 },
    },
  },
);
```

Importar `ScreeningCheckKind` desde `@property-manager/adapters` al inicio del archivo.

- [ ] **Step 2: Escribir las pruebas que fallan para `screening.service.ts`**

Crear `apps/api/src/services/screening.service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { pollScreeningResult, runScreeningRequest, triggerScreeningIfConsented } from './screening.service.js';

const TENANT_ID = 'tenant_test_screening_service';

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed(overrides: { consented?: boolean; fullName?: string } = {}) {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Screening Service Test', province: 'BC' } });
  await prisma.user.create({
    data: {
      tenantId: TENANT_ID, email: `pm-${TENANT_ID}@example.com`, passwordHash: 'x',
      firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
    },
  });
  const property = await prisma.property.create({
    data: { tenantId: TENANT_ID, name: 'Pacific Ridge', address: '100 Test St', city: 'Vancouver', province: 'BC' },
  });
  const unit = await prisma.unit.create({
    data: { tenantId: TENANT_ID, propertyId: property.id, name: 'Unit 101', rentCents: 200_000, slug: `unit-101-${TENANT_ID}` },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, name: 'Ana', phone: '+16045550111', status: 'contacted' },
  });
  const showing = await prisma.showing.create({
    data: { tenantId: TENANT_ID, leadId: lead.id, unitId: unit.id, scheduledAt: new Date(), status: 'completed' },
  });
  const consentedAt = overrides.consented === false ? null : new Date();
  const application = await prisma.rentalApplication.create({
    data: {
      tenantId: TENANT_ID, showingId: showing.id, leadId: lead.id, unitId: unit.id,
      tokenHash: `hash_${TENANT_ID}`, expiresAt: new Date(Date.now() + 86_400_000),
      status: 'submitted', applicantFullName: overrides.fullName ?? 'Ana Prospect',
      dateOfBirth: new Date('1990-05-15'), currentAddress: '123 Test St',
      currentCity: 'Vancouver', currentProvince: 'British Columbia', currentPostalCode: 'V6B 1A1',
      consentApplicationAt: consentedAt, consentCreditCheckAt: consentedAt, consentPoliceCheckAt: consentedAt,
    },
  });
  return { applicationId: application.id };
}

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('triggerScreeningIfConsented', () => {
  it('marca ambos checkeos como requested cuando hay consentimiento', async () => {
    const { applicationId } = await seed();
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('requested');
    expect(row.criminalCheckStatus).toBe('requested');
    expect(row.creditCheckRequestedAt).not.toBeNull();
  });

  it('no dispara nada sin consentimiento', async () => {
    const { applicationId } = await seed({ consented: false });
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBeNull();
    expect(row.criminalCheckStatus).toBeNull();
  });
});

describe('runScreeningRequest', () => {
  it('persiste pending y la referencia del proveedor', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
    expect(row.creditCheckProviderRef).toMatch(/^mock_credit_/);
  });
});

describe('pollScreeningResult', () => {
  it('al completarse guarda el reporte, el resumen, y notifica al staff', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'criminal');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'criminal', midway.criminalCheckProviderRef!);

    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.criminalCheckStatus).toBe('passed');
    expect(row.criminalCheckSummary).toContain('No criminal record');
    expect(row.criminalCheckReportKey).not.toBeNull();
    expect(row.criminalCheckCompletedAt).not.toBeNull();
  });

  it('un solicitante marcado "Flagged" produce el veredicto flagged', async () => {
    const { applicationId } = await seed({ fullName: 'Flagged Applicant' });
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('flagged');
  });

  it('devuelve done:false mientras sigue pending', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().screening, 'pollResult').mockResolvedValue({
      status: 'pending', providerRef: midway.creditCheckProviderRef!,
    });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);
    expect(done).toBe(false);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
  });

  it('un fallo del adapter marca failed y avisa al staff, sin lanzar', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().screening, 'pollResult').mockResolvedValue({
      status: 'failed', reason: 'Portal login failed',
    });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);
    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('failed');
    expect(row.creditCheckSummary).toContain('Portal login failed');
  });
});
```

Los campos exactos requeridos por `Lead`/`Unit`/`Property`/`Showing` deben confirmarse contra `apps/api/prisma/schema.prisma` antes de escribir el seed — si alguno es obligatorio y falta arriba, agregarlo.

- [ ] **Step 3: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- screening.service
```

- [ ] **Step 4: Implementar `screening.service.ts`**

Crear `apps/api/src/services/screening.service.ts`:

```ts
/**
 * Orquesta los dos checkeos de screening (crédito, antecedentes penales):
 * disparo tras consentimiento, envío al adapter, sondeo del resultado.
 */
import type { ScreeningCheckKind } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { writeAudit } from './audit.service.js';
import { buildDocumentStorageKey, createLocalDocumentStorage, decodeBase64Payload } from './document-storage.service.js';
import { notifyStaffTargets, resolveStaffNotifyTargets, type NotifiableStaff } from './staff-notify.service.js';
import { screeningPollQueue, screeningRequestQueue } from '../jobs/queues.js';

const STATUS_FIELD: Record<ScreeningCheckKind, 'creditCheckStatus' | 'criminalCheckStatus'> = {
  credit: 'creditCheckStatus',
  criminal: 'criminalCheckStatus',
};
const SUMMARY_FIELD: Record<ScreeningCheckKind, 'creditCheckSummary' | 'criminalCheckSummary'> = {
  credit: 'creditCheckSummary',
  criminal: 'criminalCheckSummary',
};
const REPORT_KEY_FIELD: Record<ScreeningCheckKind, 'creditCheckReportKey' | 'criminalCheckReportKey'> = {
  credit: 'creditCheckReportKey',
  criminal: 'criminalCheckReportKey',
};
const PROVIDER_REF_FIELD: Record<ScreeningCheckKind, 'creditCheckProviderRef' | 'criminalCheckProviderRef'> = {
  credit: 'creditCheckProviderRef',
  criminal: 'criminalCheckProviderRef',
};
const REQUESTED_AT_FIELD: Record<ScreeningCheckKind, 'creditCheckRequestedAt' | 'criminalCheckRequestedAt'> = {
  credit: 'creditCheckRequestedAt',
  criminal: 'criminalCheckRequestedAt',
};
const COMPLETED_AT_FIELD: Record<ScreeningCheckKind, 'creditCheckCompletedAt' | 'criminalCheckCompletedAt'> = {
  credit: 'creditCheckCompletedAt',
  criminal: 'criminalCheckCompletedAt',
};

export async function triggerScreeningIfConsented(applicationId: string, tenantId: string): Promise<void> {
  const application = await prisma.rentalApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { consentCreditCheckAt: true, consentPoliceCheckAt: true },
  });
  if (!application || !application.consentCreditCheckAt || !application.consentPoliceCheckAt) return;

  const now = new Date();
  await prisma.rentalApplication.update({
    where: { id: applicationId },
    data: {
      creditCheckStatus: 'requested',
      creditCheckRequestedAt: now,
      criminalCheckStatus: 'requested',
      criminalCheckRequestedAt: now,
    },
  });

  await screeningRequestQueue.add('run-screening-request', { tenantId, applicationId, kind: 'credit' });
  await screeningRequestQueue.add('run-screening-request', { tenantId, applicationId, kind: 'criminal' });
}

export async function runScreeningRequest(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
): Promise<void> {
  const application = await prisma.rentalApplication.findFirstOrThrow({
    where: { id: applicationId, tenantId },
  });

  const { getAdapters } = await import('../config/adapters.js');
  const result = await getAdapters().screening.runCheck(kind, {
    fullName: application.applicantFullName ?? '',
    dateOfBirth: application.dateOfBirth?.toISOString().slice(0, 10) ?? '',
    currentAddress: application.currentAddress ?? '',
    currentCity: application.currentCity ?? '',
    currentProvince: application.currentProvince ?? '',
    currentPostalCode: application.currentPostalCode ?? '',
  });

  if (result.status === 'pending') {
    await prisma.rentalApplication.update({
      where: { id: applicationId },
      data: { [STATUS_FIELD[kind]]: 'pending', [PROVIDER_REF_FIELD[kind]]: result.providerRef },
    });
    await screeningPollQueue.add(
      'poll-screening-result',
      { tenantId, applicationId, kind, providerRef: result.providerRef },
      { delay: 15 * 60_000 },
    );
    return;
  }

  await persistTerminalResult(applicationId, tenantId, kind, result);
}

export async function pollScreeningResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  providerRef: string,
): Promise<{ done: boolean }> {
  const { getAdapters } = await import('../config/adapters.js');
  const result = await getAdapters().screening.pollResult(kind, providerRef);

  if (result.status === 'pending') return { done: false };

  await persistTerminalResult(applicationId, tenantId, kind, result);
  return { done: true };
}

async function persistTerminalResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  result: { status: 'completed'; verdict: 'passed' | 'flagged'; summary: string; reportBase64: string; reportMimeType: string }
    | { status: 'failed'; reason: string },
): Promise<void> {
  if (result.status === 'failed') {
    await prisma.rentalApplication.update({
      where: { id: applicationId },
      data: {
        [STATUS_FIELD[kind]]: 'failed',
        [SUMMARY_FIELD[kind]]: result.reason,
        [COMPLETED_AT_FIELD[kind]]: new Date(),
      },
    });
    await notifyScreeningResult(applicationId, tenantId, kind, 'failed');
    return;
  }

  const env = getEnv();
  const storage = createLocalDocumentStorage({
    rootDir: env.DOCUMENT_STORAGE_DIR,
    publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined,
  });
  const stored = await storage.putObject({
    key: buildDocumentStorageKey({
      tenantId, documentId: `${applicationId}-${kind}`, filename: `${kind}-report.pdf`,
    }),
    body: decodeBase64Payload(result.reportBase64),
    contentType: result.reportMimeType,
  });

  await prisma.rentalApplication.update({
    where: { id: applicationId },
    data: {
      [STATUS_FIELD[kind]]: result.verdict,
      [SUMMARY_FIELD[kind]]: result.summary,
      [REPORT_KEY_FIELD[kind]]: stored.storageKey,
      [COMPLETED_AT_FIELD[kind]]: new Date(),
    },
  });
  await notifyScreeningResult(applicationId, tenantId, kind, result.verdict);
}

/**
 * Best-effort, igual que notifyStaffOfApplication (Fase 2A): el resultado
 * ya quedó guardado, un fallo de notificación no debe propagarse.
 */
async function notifyScreeningResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  outcome: 'passed' | 'flagged' | 'failed',
): Promise<void> {
  try {
    const application = await prisma.rentalApplication.findUniqueOrThrow({
      where: { id: applicationId },
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

    const checkLabel = kind === 'credit' ? 'Credit check' : 'Criminal record check';
    const outcomeText = outcome === 'failed'
      ? 'could not be completed'
      : outcome === 'flagged'
        ? 'came back flagged for review'
        : 'came back clear';
    const { getEnv } = await import('../config/env.js');
    const link = `${getEnv().WEB_URL}/showings`;
    const body = `${checkLabel} for ${application.lead.name ?? 'a lead'} ${outcomeText}.\n\n${link}`;

    const { getAdapters } = await import('../config/adapters.js');
    await notifyStaffTargets({
      targets, subject: `${checkLabel} result ready`, body, messaging: getAdapters().messaging,
    });
  } catch (error) {
    console.error(`[Screening] No se pudo notificar el resultado de ${applicationId}:`, error);
  }
}
```

**Verificar contra el código real** el nombre exacto de los campos de
`Lead` (`assignedUserId`, `name`) y `Showing` (`brokerUserId`) usados en
el `include` — ya confirmados en `rental-application.service.ts`, deben
coincidir.

- [ ] **Step 5: Cablear el disparo en `submitRentalApplication`**

En `apps/api/src/services/rental-application.service.ts`, justo después de:

```ts
  await notifyStaffOfApplication(application.id, application.tenantId, deps);
```

agregar:

```ts
  await triggerScreeningIfConsented(application.id, application.tenantId);
```

Importar `triggerScreeningIfConsented` desde `./screening.service.js`.

- [ ] **Step 6: Registrar los workers**

En `apps/api/src/jobs/worker.ts`, junto a los workers existentes:

```ts
  const screeningRequestWorker = new Worker<ScreeningRequestJobData>(
    QUEUE_NAMES.screeningRequest,
    async (job) => {
      await runScreeningRequest(job.data.applicationId, job.data.tenantId, job.data.kind);
    },
    { connection: redis },
  );

  const screeningPollWorker = new Worker<ScreeningPollJobData>(
    QUEUE_NAMES.screeningPoll,
    async (job) => {
      const { done } = await pollScreeningResult(
        job.data.applicationId, job.data.tenantId, job.data.kind, job.data.providerRef,
      );
      if (!done) {
        // BullMQ ya reintenta según defaultJobOptions.attempts/backoff de la
        // cola — lanzar aquí hace que el job se reintente con el backoff
        // configurado (15 min fijos) en vez de completarse prematuramente.
        throw new Error('Screening result still pending');
      }
    },
    { connection: redis },
  );
```

Importar `ScreeningRequestJobData`/`ScreeningPollJobData` desde `./queues.js` y `runScreeningRequest`/`pollScreeningResult` desde `../services/screening.service.js`. Verificar contra el código real de `worker.ts` el patrón exacto de registro/cierre de workers (¿se agregan a un array que se cierra en `shutdown`? revisar los workers existentes y seguir el mismo patrón).

- [ ] **Step 7: Correr toda la suite y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/jobs/queues.ts apps/api/src/jobs/worker.ts apps/api/src/services/screening.service.ts apps/api/src/services/screening.service.test.ts apps/api/src/services/rental-application.service.ts
git commit -m "feat: disparo automático y jobs de sondeo del screening"
```

---

## Task 5: El formulario público gana fecha de nacimiento y dirección

**Files:**
- Modify: `apps/api/src/services/rental-application.service.ts`
- Modify: `apps/api/src/routes/leads.ts`
- Modify: `apps/web/src/pages/ApplyPage.tsx`
- Test: `apps/api/src/services/rental-application.service.test.ts`

**Interfaces:**
- Consumes: nada nuevo — extiende `SubmitApplicationInput`/`submitRentalApplication` (Fase 2A).
- Produces: `SubmitApplicationInput` gana `dateOfBirth: string`, `currentAddress: string`, `currentCity: string`, `currentProvince: string`, `currentPostalCode: string` (todos requeridos, a diferencia de `annualIncome`/`employerName`/`references` que ya eran opcionales).

- [ ] **Step 1: Escribir la prueba que falla**

Agregar a `apps/api/src/services/rental-application.service.test.ts` (buscar el `describe('submitRentalApplication')` ya existente y agregar dentro):

```ts
it('rechaza el envío sin fecha de nacimiento o dirección', async () => {
  const result = await submitRentalApplication(TOKEN, {
    ...VALID_SUBMIT_INPUT, // usar el helper/objeto base que ya construyen las pruebas existentes de este describe
    dateOfBirth: '',
  }, { messaging: MOCK_MESSAGING });
  expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('dateOfBirth') });
});

it('guarda fecha de nacimiento y dirección al enviar', async () => {
  const result = await submitRentalApplication(TOKEN, {
    ...VALID_SUBMIT_INPUT,
    dateOfBirth: '1990-05-15',
    currentAddress: '456 Main St',
    currentCity: 'Burnaby',
    currentProvince: 'British Columbia',
    currentPostalCode: 'V5H 1A1',
  }, { messaging: MOCK_MESSAGING });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: result.applicationId } });
  expect(row.dateOfBirth?.toISOString().slice(0, 10)).toBe('1990-05-15');
  expect(row.currentAddress).toBe('456 Main St');
});
```

Verificar el nombre real del objeto/helper base que las pruebas existentes de `submitRentalApplication` usan para el input válido (`VALID_SUBMIT_INPUT` es un placeholder de este plan — usar el que el archivo real ya tenga) y el nombre real de `MOCK_MESSAGING`/equivalente. No copiar a ciegas si el archivo usa otro patrón — leer las pruebas existentes primero.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- rental-application.service
```

- [ ] **Step 3: Extender `SubmitApplicationInput` y la validación**

En `apps/api/src/services/rental-application.service.ts`, buscar la declaración de `SubmitApplicationInput` (o el tipo equivalente que `submitRentalApplication` recibe) y agregar:

```ts
  dateOfBirth: string; // ISO date
  currentAddress: string;
  currentCity: string;
  currentProvince: string;
  currentPostalCode: string;
```

En el cuerpo de `submitRentalApplication`, junto a la validación existente de `applicantFullName`:

```ts
  if (!input.dateOfBirth.trim()) {
    return { ok: false, status: 400, error: 'dateOfBirth is required' };
  }
  if (!input.currentAddress.trim() || !input.currentCity.trim() || !input.currentProvince.trim() || !input.currentPostalCode.trim()) {
    return { ok: false, status: 400, error: 'A complete current address is required' };
  }
```

Y en el `updateMany` que persiste la solicitud, agregar los campos:

```ts
      dateOfBirth: new Date(input.dateOfBirth),
      currentAddress: input.currentAddress.trim(),
      currentCity: input.currentCity.trim(),
      currentProvince: input.currentProvince.trim(),
      currentPostalCode: input.currentPostalCode.trim(),
```

- [ ] **Step 4: Extender la ruta pública**

En `apps/api/src/routes/leads.ts`, dentro del handler `publicRouter.post('/applications/:token', ...)`, agregar al objeto que se pasa a `submitRentalApplication`:

```ts
        dateOfBirth: typeof body.dateOfBirth === 'string' ? body.dateOfBirth : '',
        currentAddress: typeof body.currentAddress === 'string' ? body.currentAddress : '',
        currentCity: typeof body.currentCity === 'string' ? body.currentCity : '',
        currentProvince: typeof body.currentProvince === 'string' ? body.currentProvince : '',
        currentPostalCode: typeof body.currentPostalCode === 'string' ? body.currentPostalCode : '',
```

- [ ] **Step 5: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- rental-application.service
```

- [ ] **Step 6: El formulario web**

En `apps/web/src/pages/ApplyPage.tsx`, junto al campo `applicantFullName` existente, agregar los campos nuevos al formulario (mismo estilo de `<input>` que el resto del formulario — clases `mt-1 w-full rounded-md border border-slate-300 px-3 py-2`, `required`):

```tsx
        <div>
          <label className="block text-sm font-medium text-slate-700">Date of birth</label>
          <input name="dateOfBirth" type="date" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Current address</label>
          <input name="currentAddress" type="text" required placeholder="Street address" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <input name="currentCity" type="text" required placeholder="City" className="mt-1 rounded-md border border-slate-300 px-3 py-2" />
          <input name="currentProvince" type="text" required placeholder="Province" className="mt-1 rounded-md border border-slate-300 px-3 py-2" />
          <input name="currentPostalCode" type="text" required placeholder="Postal code" className="mt-1 rounded-md border border-slate-300 px-3 py-2" />
        </div>
```

Y en el handler de envío del formulario (buscar dónde ya se construye el `payload` con `annualIncome`/`applicantFullName` desde `form.get(...)`), agregar:

```ts
      dateOfBirth: String(form.get('dateOfBirth') ?? ''),
      currentAddress: String(form.get('currentAddress') ?? ''),
      currentCity: String(form.get('currentCity') ?? ''),
      currentProvince: String(form.get('currentProvince') ?? ''),
      currentPostalCode: String(form.get('currentPostalCode') ?? ''),
```

- [ ] **Step 7: Verificar que compila**

```bash
pnpm --filter @property-manager/web test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/rental-application.service.ts apps/api/src/routes/leads.ts apps/web/src/pages/ApplyPage.tsx apps/api/src/services/rental-application.service.test.ts
git commit -m "feat: capturar fecha de nacimiento y dirección en la solicitud de renta"
```

---

## Task 6: `PlaywrightScreeningAdapter` — BLOQUEADO, no dispatchable todavía

**Este es el único punto del plan que NO se ejecuta con un subagente ahora
mismo.** Se documenta completo para que quede claro qué falta y por qué,
no como un placeholder.

**Por qué está bloqueado:** no existe cuenta creada con FrontLobby ni con
Sterling (confirmado por el usuario durante el brainstorming de este
spec). Sin una cuenta, no hay portal que observar — y el asistente **no
puede iniciar sesión con la contraseña real del usuario**, sin excepción
(restricción de seguridad de este proyecto, no una elección de diseño).
Escribir selectores CSS o el flujo exacto de login/formulario sin haber
visto la página real sería adivinar, exactamente lo que este proyecto ha
evitado en cada fase.

**Qué hace falta para desbloquearla**, en orden:

1. El usuario crea una cuenta de cliente normal en FrontLobby y/o
   Sterling (registro público, sin pasar por ventas — ver
   [`docs/SCREENING_PROVIDER_OUTREACH.md`](../../SCREENING_PROVIDER_OUTREACH.md)
   para el contacto de API en paralelo, que no bloquea esto).
2. El usuario navega el portal (login → pantalla de nueva solicitud de
   screening → pantalla de resultado) **él mismo** — con capturas de
   pantalla, o compartiendo la sesión mientras Claude observa la
   estructura sin tocar el campo de contraseña — y reporta:
   - ¿Cuántos pasos tiene el login? ¿Pide 2FA o CAPTCHA?
   - La URL exacta del formulario de nueva solicitud.
   - Los campos exactos que pide (¿coinciden con
     `ScreeningApplicantInput` de la Tarea 2, o hace falta un campo más
     como SIN/número de seguro social?).
   - Cómo se ve la pantalla de resultado — ¿hay un estado "en trámite"
     visible? ¿Cuánto tarda típicamente un checkeo real?
3. Con esa información, se puede escribir una tarea nueva (fuera de este
   plan) para `PlaywrightScreeningAdapter`, con selectores reales,
   pruebas contra un fixture HTML local que reproduce la estructura
   observada, y las credenciales viniendo de
   `getIntegrationCredentials` (Tarea 3).

**Mientras tanto**, el sistema completo (Tareas 1-5, 7) funciona de
punta a punta contra `ScreeningMockAdapter` — el disparo, el sondeo, el
almacenamiento del reporte, la notificación, y la UI son reales y
probados; solo el adapter que de verdad habla con FrontLobby/Sterling
está pendiente.

---

## Task 7: Interfaz — pantalla de Integraciones, resultado en Showings, y roadmap

**Files:**
- Create: `apps/web/src/pages/IntegrationsPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/Layout.tsx`
- Modify: `apps/web/src/pages/ShowingsPage.tsx`
- Modify: `apps/web/src/lib/types.ts`
- Modify: `docs/PRODUCT_ROADMAP.md`

**Interfaces:**
- Consumes: `GET /integrations`, `POST /integrations` (Tarea 3); el `GET /showings/:id/application` existente (Fase 2A), que ahora también trae los campos de screening de la Tarea 1 — Prisma los devuelve por default salvo que la ruta use un `select` que los excluya explícitamente (verificar contra el código real de esa ruta).

- [ ] **Step 1: Tipos**

En `apps/web/src/lib/types.ts`, extender el tipo de aplicación (buscar el que ya usa `ShowingsPage.tsx` para `ApplicationDetail`, probablemente local a esa página según lo que ya se confirmó en el brainstorming — si es local, extenderlo ahí en vez de en `types.ts`) con:

```ts
  dateOfBirth?: string | null;
  currentAddress?: string | null;
  currentCity?: string | null;
  currentProvince?: string | null;
  currentPostalCode?: string | null;
  creditCheckStatus?: string | null;
  creditCheckSummary?: string | null;
  creditCheckReportKey?: string | null;
  criminalCheckStatus?: string | null;
  criminalCheckSummary?: string | null;
  criminalCheckReportKey?: string | null;
```

- [ ] **Step 2: `IntegrationsPage.tsx`**

Crear siguiendo las convenciones de estilo de `OwnerStatementsPage.tsx`/`AuditPage.tsx` (leer antes de escribir):

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { useAuth } from '../auth/AuthContext';

interface IntegrationStatus {
  provider: 'frontlobby_portal' | 'sterling_portal';
  status: string;
  lastSyncedAt: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  frontlobby_portal: 'FrontLobby (credit check)',
  sterling_portal: 'Sterling (criminal record check)',
};

export function IntegrationsPage() {
  const { user } = useAuth();
  const canManage = user?.role === 'property_manager';
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, { username: string; password: string }>>({});

  const integrations = useQuery<{ integrations: IntegrationStatus[] }>({
    queryKey: ['integrations'],
    queryFn: () => apiFetch('/integrations'),
  });

  const save = useMutation({
    mutationFn: (input: { provider: string; username: string; password: string }) =>
      apiFetch('/integrations', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations'] }),
  });

  // ...render: una tarjeta por entrada de integrations.data.integrations,
  // con campos de usuario/contraseña (draft por proveedor en `drafts`),
  // botón guardar deshabilitado si !canManage, y el status renderizado
  // como texto legible ('not_configured' -> "Not connected", 'pending' ->
  // "Saved, not yet verified", 'connected' -> "Connected", 'error' ->
  // "Connection error").
}
```

Completar el render siguiendo el patrón de tarjetas ya establecido en
`OwnerStatementsPage.tsx`. La contraseña **nunca** se pre-llena desde
`integrations.data` (la API nunca la devuelve) — el campo de contraseña
siempre arranca vacío en `drafts`.

- [ ] **Step 3: Ruta y menú**

En `apps/web/src/App.tsx`:

```tsx
        <Route path="/integrations" element={<IntegrationsPage />} />
```

En `apps/web/src/components/Layout.tsx`, agregar una entrada de menú
"Integrations" apuntando a `/integrations`, siguiendo el mismo patrón de
las entradas existentes (verificar el array/estructura real del menú
antes de agregar).

- [ ] **Step 4: Ruta para descargar el reporte — no hay patrón existente que seguir**

`ShowingsPage.tsx:139-148` ya muestra que el documento de ID subido en la
Fase 2A **nunca ganó una ruta que lo sirva** — el comentario en ese mismo
bloque dice explícitamente *"no existe ninguna ruta en la app que sirva
archivos de DOCUMENT_STORAGE_DIR — servir/descargar el documento queda
fuera de alcance... y es trabajo futuro"*. Repetir ese vacío para el
reporte de screening dejaría sin sentido la decisión de guardar el
reporte completo (spec Sección 1.2: *"se copia completamente el reporte,
pero se muestra... un resumen"* — el resumen es para decidir rápido, el
reporte completo es para cuando el resumen no basta).

Agregar una ruta autenticada y aislada por tenant en
`apps/api/src/routes/leads.ts` (junto a las demás rutas de
`RentalApplication`):

```ts
leadsRouter.get('/applications/:applicationId/report/:kind', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { applicationId, kind } = req.params;
    if (kind !== 'credit' && kind !== 'criminal') {
      res.status(400).json({ error: 'Invalid report kind' });
      return;
    }
    const application = await prisma.rentalApplication.findFirst({
      where: { id: applicationId, tenantId: user.tenantId },
      select: { creditCheckReportKey: true, criminalCheckReportKey: true },
    });
    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    const key = kind === 'credit' ? application.creditCheckReportKey : application.criminalCheckReportKey;
    if (!key) {
      res.status(404).json({ error: 'Report not available' });
      return;
    }

    const env = getEnv();
    const root = path.resolve(env.DOCUMENT_STORAGE_DIR);
    const target = path.resolve(root, key);
    // Mismo guard de path traversal que ya usa createLocalDocumentStorage
    // al escribir — se repite aquí porque este es un punto de lectura
    // independiente, no una llamada a ese servicio.
    if (!target.startsWith(root)) {
      res.status(400).json({ error: 'Invalid report path' });
      return;
    }
    const file = await fs.readFile(target);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${kind}-report.pdf"`);
    res.send(file);
  } catch (err) {
    next(err);
  }
});
```

`apps/api/src/routes/leads.ts` ya importa `prisma`, `requireAuth`, y
`requireUser` — no hace falta agregarlos. Sí hace falta agregar, al
inicio del archivo: `import { promises as fs } from 'node:fs';`,
`import path from 'node:path';`, y
`import { getEnv } from '../config/env.js';` (ninguno de los tres está
importado ahí hoy). `key` (el `storageKey` guardado) se
valida contra el `applicationId` del propio tenant antes de tocar el
disco — un usuario autenticado de un tenant no puede pedir el reporte de
otro tenant aunque adivinara el `storageKey`, porque la fila de
`RentalApplication` que lo contiene ni siquiera se encuentra fuera de su
`tenantId`.

**En `ShowingsPage.tsx`**, en la sección que ya renderiza
`ApplicationDetail` (junto a `annualIncome`/`employerName`/`references`),
agregar dos bloques — crédito y antecedentes — cada uno con el estado
(`requested`/`pending`/`passed`/`flagged`/`failed`, con color: gris para
requested/pending, verde para passed, ámbar para flagged, rojo para
failed), el resumen si el estado no es `requested`/`pending`, y — solo
si `creditCheckReportKey`/`criminalCheckReportKey` existe — un link
`<a href={`/showings/applications/${app.id}/report/credit`} target="_blank">`
apuntando a la ruta nueva (ajustar el path exacto al que realmente quede
montado el router — verificar el prefijo de montaje de `leadsRouter` en
`app.ts` antes de fijar la URL final en el frontend).

- [ ] **Step 5: Verificar que compila**

```bash
pnpm --filter @property-manager/web test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 6: Roadmap**

En `docs/PRODUCT_ROADMAP.md`, sección 2.2, marcar el nivel 2 (automatización
de navegador) como entregado con una nota clara: nivel 1 (API) y nivel 3
(PDF+OCR) pendientes, y la automatización específica del portal
(Tarea 6 de este plan) bloqueada hasta que existan las cuentas de
FrontLobby/Sterling.

- [ ] **Step 7: Regresión completa del monorepo**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Esperado: todo verde en los cuatro paquetes. Si algo falla, no commitear:
reportar.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src docs/PRODUCT_ROADMAP.md
git commit -m "feat: pantalla de integraciones, resultado de screening en Showings, roadmap"
```

---

## Notas para quien ejecute el plan

- **La Tarea 6 no se despacha a un subagente.** Es documentación de un
  bloqueo real, no una tarea ejecutable — el controlador debe saltarla y
  reportarla al usuario como pendiente, con las instrucciones exactas de
  qué información recolectar cuando exista la cuenta.
- **Las Tareas 1-5 y 7 sí forman un sistema completo y probado**, solo que
  detrás de `ScreeningMockAdapter` en vez del adapter real — esto es
  intencional (spec Sección 5), no una limitación oculta.
- **Si una prueba no pasa, se reporta BLOCKED.** No se commitea en rojo.

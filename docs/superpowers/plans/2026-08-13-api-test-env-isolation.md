# Aislamiento de entorno para tests de `apps/api` — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Garantizar que `pnpm --filter @property-manager/api test` siempre
corre contra adapters mock, sin importar qué credenciales de integración
tenga exportadas el shell/IDE del desarrollador.

**Architecture:** Una constante única (`INTEGRATION_CREDENTIAL_ENV_KEYS`)
en `packages/config` enumera cada variable de credencial de integración.
`apps/api/vitest.config.ts` usa `test.env` de Vitest para forzar esas
variables a `''` (y `NODE_ENV` a `'test'`) en el proceso de test, sin tocar
`isIntegrationConfigured`/`createAdapters` (cuya lógica de selección ya es
correcta y ya se prueba en `packages/adapters/src/factory.test.ts` con
`Env` construidos a mano).

**Tech Stack:** TypeScript, Vitest 2.x, Zod (sin dependencias nuevas).

## Global Constraints

- No modificar `isIntegrationConfigured` ni `createAdapters` — cambiar su
  lógica rompería `packages/adapters/src/factory.test.ts`, que
  deliberadamente inyecta credenciales falsas para probar la rama de
  adapter real.
- No tocar `DATABASE_URL`, `REDIS_URL`, secretos JWT ni
  `INTEGRATION_ENCRYPTION_KEY` — 19 archivos de test en `apps/api/src`
  pegan contra el Postgres/Redis local de `docker-compose.yml` y necesitan
  esos valores reales del `.env` del desarrollador.
- No agregar `dotenv`/`dotenv-flow` ni ninguna dependencia nueva — Vitest
  ya trae el mecanismo (`test.env`) necesario.

---

### Task 1: Constante `INTEGRATION_CREDENTIAL_ENV_KEYS` en `packages/config`

**Files:**
- Modify: `packages/config/src/env.ts` (agregar la constante después de
  `isIntegrationConfigured`, línea ~197 en el estado actual del archivo)

**Interfaces:**
- Produces: `INTEGRATION_CREDENTIAL_ENV_KEYS: readonly (keyof Env)[]` —
  Task 2 la importa desde `@property-manager/config` (ya re-exportado vía
  `packages/config/src/index.ts` → `export * from './env.js'`, no requiere
  tocar `index.ts`).

`packages/config` no tiene runner de tests configurado hoy (solo
`typecheck` en su `package.json`) — no se le agrega Vitest solo para una
constante literal. La verificación de este task es el compilador
(`tsc --noEmit`), y el uso real de la constante se verifica en Task 2.

- [ ] **Step 1: Agregar la constante**

Al final de `packages/config/src/env.ts`, después de la función
`isIntegrationConfigured` (que termina en la línea 197 con el cierre de la
función), agregar:

```ts
/**
 * Nombres exactos de las variables de entorno que `isIntegrationConfigured`
 * lee para decidir si una integración está configurada. Es la fuente única
 * de verdad que usa `apps/api/vitest.config.ts` para forzarlas a estar
 * vacías durante los tests, sin importar lo que el shell/IDE del
 * desarrollador tenga exportado.
 *
 * IMPORTANTE: si agregas una integración nueva a `IntegrationKey` y a
 * `isIntegrationConfigured`, agrega también sus variables aquí.
 */
export const INTEGRATION_CREDENTIAL_ENV_KEYS = [
  'BUILDIUM_CLIENT_ID',
  'BUILDIUM_CLIENT_SECRET',
  'QBO_CLIENT_ID',
  'QBO_CLIENT_SECRET',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'STRIPE_SECRET_KEY',
  'ZAI_API_KEY',
  'AUTOENHANCE_API_KEY',
  'SHOWMOJO_API_TOKEN',
  'DOCUSIGN_INTEGRATION_KEY',
  'DOCUSIGN_USER_ID',
  'TELEGRAM_BOT_TOKEN',
  'MESSENGER_PAGE_ACCESS_TOKEN',
  'MESSENGER_APP_SECRET',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const satisfies readonly (keyof Env)[];
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @property-manager/config typecheck`
Expected: sin errores. Si `satisfies readonly (keyof Env)[]` marca algún
string como error, es que ese nombre no coincide exactamente con un campo
de `envSchema` — corrígelo comparando contra `isIntegrationConfigured` en
el mismo archivo.

- [ ] **Step 3: Commit**

```bash
git add packages/config/src/env.ts
git commit -m "feat(config): agregar INTEGRATION_CREDENTIAL_ENV_KEYS como fuente única de credenciales de integración"
```

---

### Task 2: `apps/api/vitest.config.ts` + test de regresión

**Files:**
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/config/adapters.test.ts`

**Interfaces:**
- Consumes: `INTEGRATION_CREDENTIAL_ENV_KEYS` (Task 1, de
  `@property-manager/config`); `getEnv()` de `apps/api/src/config/env.ts`
  (ya existe, sin cambios); `getAdapters()` de
  `apps/api/src/config/adapters.ts` (ya existe, sin cambios).

- [ ] **Step 1: Escribir el test de regresión (debe fallar en rojo)**

Crear `apps/api/src/config/adapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INTEGRATION_CREDENTIAL_ENV_KEYS } from '@property-manager/config';
import { getAdapters } from './adapters.js';
import { getEnv } from './env.js';

describe('aislamiento de entorno de tests', () => {
  it('nunca resuelve credenciales de integración reales durante los tests', () => {
    const env = getEnv();
    for (const key of INTEGRATION_CREDENTIAL_ENV_KEYS) {
      expect(env[key]).toBe('');
    }
  });

  it('getAdapters() siempre cae a mocks para todas las integraciones', () => {
    const { mockModes } = getAdapters();
    for (const [integration, isMock] of Object.entries(mockModes)) {
      expect(isMock, `${integration} debería estar en modo mock`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Confirmar que el test falla hoy si el shell tiene una credencial real exportada**

Run (Bash, POSIX — usa `ZAI_API_KEY=... comando` en la misma línea):

```bash
cd apps/api && ZAI_API_KEY=fake-real-key pnpm test -- adapters.test.ts
```

Expected: FAIL — el primer `it` falla porque `env.ZAI_API_KEY` es
`'fake-real-key'`, no `''` (todavía no existe `vitest.config.ts` que lo
limpie). Esto reproduce exactamente el bug descrito en el spec: una
credencial exportada en el shell se filtra al proceso de test.

Si el test PASA en este paso (por ejemplo porque ya corriste Step 4 antes
sin darte cuenta), revisa que `apps/api/vitest.config.ts` todavía no
exista antes de continuar.

- [ ] **Step 3: Crear `apps/api/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { INTEGRATION_CREDENTIAL_ENV_KEYS } from '@property-manager/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      ...Object.fromEntries(
        INTEGRATION_CREDENTIAL_ENV_KEYS.map((key) => [key, '']),
      ),
    },
  },
});
```

- [ ] **Step 4: Confirmar que el test pasa incluso con la credencial exportada en el shell**

Run (misma variable exportada que en el Step 2, para probar que ahora se
sobreescribe):

```bash
cd apps/api && ZAI_API_KEY=fake-real-key pnpm test -- adapters.test.ts
```

Expected: PASS — ambos `it` en verde. `test.env` de Vitest sobreescribió
`ZAI_API_KEY` a `''` en el proceso de test antes de que `adapters.test.ts`
se cargara, sin importar que el shell padre la tuviera seteada.

- [ ] **Step 5: Correr toda la suite de `apps/api` para confirmar que nada más se rompió**

Run: `pnpm --filter @property-manager/api test`
Expected: PASS — mismo resultado que antes de este cambio (mismo número de
tests en verde). Si algo se rompe, es probable que algún test dependiera
de una variable de infraestructura que `test.env` no debería tocar —
revisa que `vitest.config.ts` solo liste claves de
`INTEGRATION_CREDENTIAL_ENV_KEYS` y `NODE_ENV`.

- [ ] **Step 6: Correr la suite de `packages/adapters` para confirmar que su lógica de selección sigue intacta**

Run: `pnpm --filter @property-manager/adapters test`
Expected: PASS — `factory.test.ts` no se toca en este plan y debe seguir
en verde exactamente igual que antes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/vitest.config.ts apps/api/src/config/adapters.test.ts
git commit -m "test(api): aislar credenciales de integración en tests via vitest.config test.env"
```

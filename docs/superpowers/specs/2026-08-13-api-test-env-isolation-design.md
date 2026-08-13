# Aislamiento de entorno para tests de `apps/api` — Diseño

## 1. Problema

`getAdapters()` (`apps/api/src/config/adapters.ts`) cachea un singleton por
proceso construido con `getEnv()` (`apps/api/src/config/env.ts`), que a su
vez lee `process.env` real vía `loadEnv()`
(`packages/config/src/env.ts`). No existe `vitest.config.ts` en `apps/api`
ni `.env.test`, y el script `test` es `vitest run` a secas.

Consecuencia: si el shell que corre `pnpm --filter @property-manager/api
test` tiene credenciales reales exportadas (p. ej. `ZAI_API_KEY` cargada
desde el `.env` local del desarrollador por su perfil de shell/IDE),
`isIntegrationConfigured(env, key)` puede devolver `true` en tests, y
`getAdapters()` resuelve al adapter *real* de esa integración en vez de al
mock. Esto se confirmó como problema real durante la revisión de la Fase
2.2 nivel 3 (carga manual de reportes de screening, commit `1dac825`): un
test que llama `getAdapters().glm.extractScreeningReport(...)` sin
mockearlo explícitamente terminaba pegándole a la API real de GLM si el
desarrollador tenía `ZAI_API_KEY` exportada.

El mismo patrón de riesgo existe para **cualquier** integración listada en
`IntegrationKey` (`buildium`, `qbo`, `twilio`, `plaid`, `stripe`, `glm`,
`photo_enhancement`, `showmojo`, `docusign`, `telegram`, `messenger`,
`email`, `google_calendar`) — no es específico de GLM.

## 2. Qué NO hay que romper

`packages/adapters/src/factory.test.ts` prueba `createAdapters(env)`
directamente construyendo objetos `Env` a mano (nunca lee `process.env`) y
**depende de que `isIntegrationConfigured` siga devolviendo `true` cuando
la prueba mete credenciales falsas** (p. ej. `ZAI_API_KEY: 'zai-secret'` →
espera `GlmRealAdapter`). Cualquier solución que gatee
`isIntegrationConfigured` por `NODE_ENV === 'test'` rompería esas pruebas
existentes — descartado.

El riesgo real no está en la lógica de selección (`isIntegrationConfigured`
/ `createAdapters`), que ya es correcta y ya se prueba de forma aislada.
Está en que `apps/api`, al usar el singleton `getAdapters()` respaldado por
`process.env` real sin pasar un `env` explícito, hereda lo que sea que el
shell del desarrollador tenga exportado.

Tampoco hay que tocar las variables de infraestructura (`DATABASE_URL`,
`REDIS_URL`, secretos JWT, `INTEGRATION_ENCRYPTION_KEY`): 19 archivos de
test en `apps/api/src` instancian `PrismaClient` y pegan contra el Postgres
local de `docker-compose.yml` (puerto 5433) — esas variables sí necesitan
venir del `.env` real del desarrollador. Ese problema (bootstrap de DB de
test) es preexistente y queda fuera de alcance de este spec.

## 3. Diseño

**Paso 1 — Fuente única de verdad.** En `packages/config/src/env.ts`,
exportar `INTEGRATION_CREDENTIAL_ENV_KEYS`: un array con exactamente los
nombres de variable que `isIntegrationConfigured` lee en sus checks
(`BUILDIUM_CLIENT_ID`, `BUILDIUM_CLIENT_SECRET`, `QBO_CLIENT_ID`,
`QBO_CLIENT_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`PLAID_CLIENT_ID`, `PLAID_SECRET`, `STRIPE_SECRET_KEY`, `ZAI_API_KEY`,
`AUTOENHANCE_API_KEY`, `SHOWMOJO_API_TOKEN`, `DOCUSIGN_INTEGRATION_KEY`,
`DOCUSIGN_USER_ID`, `TELEGRAM_BOT_TOKEN`, `MESSENGER_PAGE_ACCESS_TOKEN`,
`MESSENGER_APP_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Un comentario deja explícito
que esta lista debe mantenerse alineada con `isIntegrationConfigured` —
quien agregue una integración nueva ve ambas cosas una junto a la otra en
el mismo archivo.

**Paso 2 — `apps/api/vitest.config.ts`.** Nuevo archivo que usa
`defineConfig` de `vitest/config` con `test.env` fijando `NODE_ENV: 'test'`
más cada clave de `INTEGRATION_CREDENTIAL_ENV_KEYS` en `''`. Vitest aplica
estos valores al `process.env` del proceso de test *después* de heredar el
entorno del shell padre y *antes* de cargar cualquier archivo de test —
sobreescribe cualquier credencial real exportada, sin importar el shell o
IDE del desarrollador.

Resultado: en cualquier test de `apps/api` que use el singleton
`getAdapters()`/`getEnv()` sin pasar un `env` explícito,
`isIntegrationConfigured` siempre evalúa `false` para las 13 integraciones,
así que `getAdapters()` siempre resuelve a los adapters mock — de forma
determinista, sin depender del entorno del desarrollador.

**Paso 3 — Ninguno.** Los tests que sí quieren probar la rama "credencial
configurada → adapter real" ya usan el patrón correcto
(`packages/adapters/src/factory.test.ts`): construyen un `Env` a mano y
llaman `createAdapters(env)` directo, sin pasar por `process.env` ni por el
singleton de `apps/api`. Ese patrón no se ve afectado por este cambio — no
hace falta ningún mecanismo de opt-out nuevo.

## 4. Alternativas descartadas

- **Gatear `isIntegrationConfigured` por `NODE_ENV === 'test'`.** Rompe
  `factory.test.ts` (sección 2). Descartado.
- **`.env.test` + `dotenv`/`dotenv-flow`.** El repo no usa `dotenv` en
  ningún lado hoy (ni en `apps/api`, que corre con `tsx watch`, que carga
  `.env` de forma nativa). Agregar una dependencia nueva solo para test es
  más superficie que el `test.env` de Vitest, que ya está disponible sin
  dependencias adicionales.
- **`setupFiles` que borre `process.env.X` antes de cada test.** Equivalente
  en efecto a `test.env`, pero más código (un archivo de setup) para el
  mismo resultado. `test.env` es la primitiva de Vitest pensada
  exactamente para esto.

## 5. Verificación

1. `pnpm --filter @property-manager/api test` corre limpio sin ninguna
   variable de integración exportada (baseline).
2. Repetir con `ZAI_API_KEY=fake-real-key` exportada en el shell antes del
   comando — el resultado de los tests debe ser idéntico al paso 1 (mismo
   número de tests, mismos adapters mock), confirmando que la variable del
   shell no se filtra al proceso de test.
3. `pnpm --filter @property-manager/adapters test` sigue en verde sin
   cambios (no se toca ese paquete).

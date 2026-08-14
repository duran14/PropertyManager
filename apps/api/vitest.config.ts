import { defineConfig } from 'vitest/config';
// Import relativo intencional (no `@property-manager/config` como en el
// resto del código, p.ej. adapters.test.ts). Vite externaliza los bare
// specifiers al cargar este config y delega su resolución al `import()`
// nativo de Node: ese `import()` sí puede ejecutar `./src/index.ts` (Node
// type-stripea .ts), pero ese archivo re-exporta desde `./env.js`, y Node
// nativo no remapea `.js` -> `.ts` en imports relativos (solo lo hacen
// bundlers como esbuild). El import relativo de acá sí lo bundlea esbuild,
// que sí soporta ese mapeo, sin loader adicional. Mismo archivo fuente de
// verdad, solo una ruta de import distinta. Si mueves
// packages/config/src/env.ts, actualiza esta ruta.
import { INTEGRATION_CREDENTIAL_ENV_KEYS } from '../../packages/config/src/env.js';

// Antes de que este archivo existiera, Vitest/Vite cargaban `apps/api/.env`
// hacia `process.env` de forma implícita para el proceso de test. Declarar
// `test.env` explícito (abajo) REEMPLAZA esa carga implícita en vez de
// extenderla, así que sin este `loadEnvFile` de por medio,
// `DATABASE_URL`/`REDIS_URL`/etc. quedan `undefined` y `getEnv()` revienta
// con "Variables de entorno inválidas" en cualquier corrida que no tenga
// esas variables ya exportadas en el shell ambiente. `vite`/`dotenv` no son
// dependencias directas de este paquete (pnpm bloquea importarlos sin
// declararlos) — `process.loadEnvFile` es un builtin de Node (estable desde
// Node 20.12/21.7, este repo corre en Node 24+) que hace exactamente lo
// mismo sin agregar una dependencia nueva. `try/catch` porque en CI (u otro
// entorno sin `.env` en disco, con las variables ya provistas por el
// orquestador) el archivo puede no existir — ahí no hay nada que cargar.
try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch {
  // Sin .env en disco — se asume que el entorno ya provee las variables.
}

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

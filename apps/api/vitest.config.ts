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

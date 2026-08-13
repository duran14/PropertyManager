import { defineConfig } from 'vitest/config';
// Import relativo intencional (no `@property-manager/config` como en el
// resto del código, p.ej. adapters.test.ts): Vite externaliza los imports
// de paquete al cargar este archivo de config y delega su resolución al
// `import()` nativo de Node, que no sabe mapear el `.js` -> `.ts` de las
// exports de ese paquete. Un import relativo sí lo bundlea esbuild (que sí
// soporta ese mapeo), sin loader adicional. Mismo archivo fuente de
// verdad, solo una ruta de import distinta.
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

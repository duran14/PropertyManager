import { defineConfig } from 'vitest/config';
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

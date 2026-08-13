import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_CREDENTIAL_ENV_KEYS,
  isIntegrationConfigured,
  type Env,
  type IntegrationKey,
} from '@property-manager/config';
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

  it('INTEGRATION_CREDENTIAL_ENV_KEYS cubre TODO lo que isIntegrationConfigured lee', () => {
    const leidas = new Set<string>();
    // 'x' (truthy) para que no se corte el && y se lean ambos operandos
    const espia = new Proxy({} as Env, { get: (_t, p) => (leidas.add(String(p)), 'x') });
    for (const key of Object.keys(getAdapters().mockModes) as IntegrationKey[]) {
      isIntegrationConfigured(espia, key);
    }
    expect([...leidas].sort()).toEqual([...INTEGRATION_CREDENTIAL_ENV_KEYS].sort());
  });
});

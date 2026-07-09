/**
 * Provider de adapters.
 *
 * Por ahora devuelve un set global (todos mock o real según env). En el futuro,
 * cuando las integraciones sean por-tenant (cada PM conecta su propio QBO),
 * aquí se construirá el adapter leyendo IntegrationConfig del tenant.
 */
import type { Adapters } from '@property-manager/adapters';
import { createAdapters } from '@property-manager/adapters';
import type { Env } from '@property-manager/config';
import { getEnv } from './env.js';

let cached: Adapters | undefined;

export function getAdapters(env: Env = getEnv()): Adapters {
  if (!cached) {
    cached = createAdapters(env);
  }
  return cached;
}

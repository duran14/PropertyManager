/**
 * Carga y valida las variables de entorno al arranque de la API.
 * Fail-fast: si falta algo crítico, la API no arranca.
 */
import { loadEnv, type Env } from '@property-manager/config';

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  cached = loadEnv();
  return cached;
}

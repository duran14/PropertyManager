/**
 * Cliente Redis (ioredis) para BullMQ.
 *
 * BullMQ necesita una conexión Redis para gestionar las colas de jobs.
 * Reutilizamos la conexión para todas las colas del Financial Sentinel.
 */
import IORedis, { type Redis } from 'ioredis';
import { getEnv } from './env.js';

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
}

export const redis: Redis =
  globalThis.__redis ??
  new IORedis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null, // BullMQ requiere esto
    enableReadyCheck: true,
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__redis = redis;
}

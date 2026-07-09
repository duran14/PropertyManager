/**
 * Definición de colas BullMQ del Financial Sentinel.
 *
 * Arquitectura event-driven:
 *  - `reconciliationQueue`: job recurrente que corre el matching diario.
 *  - `bankNotificationQueue`: jobs disparados por webhooks/avisos bancarios
 *    (e-Transfer recibido). Cada aviso se procesa de forma independiente.
 *
 * Las colas se definen una sola vez y se exportan para que rutas y workers
 * las reutilicen.
 */
import { Queue, QueueEvents } from 'bullmq';
import { redis } from '../config/redis.js';

export const QUEUE_NAMES = {
  reconciliation: 'reconciliation',
  bankNotification: 'bank-notification',
} as const;

/** Job de reconciliación diaria para un tenant. */
export interface ReconciliationJobData {
  tenantId: string;
  runDate: string; // ISO date
  triggeredBy: 'cron' | 'manual';
}

/** Job de notificación bancaria (e-Transfer, depósito). */
export interface BankNotificationJobData {
  tenantId: string;
  amountCents: number;
  reference: string;
  senderName?: string;
  receivedAt: string; // ISO date
}

export const reconciliationQueue = new Queue<ReconciliationJobData, unknown, string>(QUEUE_NAMES.reconciliation, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export const bankNotificationQueue = new Queue<BankNotificationJobData, unknown, string>(QUEUE_NAMES.bankNotification, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

/**
 * Schedulea el job recurrente de reconciliación diaria.
 * Se llama al arrancar el worker (idempotente: BullMQ reemplaza si existe).
 */
export async function scheduleDailyReconciliation(tenantId: string): Promise<void> {
  await reconciliationQueue.add(
    'daily-reconciliation',
    { tenantId, runDate: new Date().toISOString(), triggeredBy: 'cron' },
    {
      // Cada día a las 06:00 AM (horario de Vancouver).
      repeat: { pattern: '0 6 * * *', tz: 'America/Vancouver' },
      jobId: `daily-${tenantId}`,
    },
  );
}

// QueueEvents para escuchar completados/fallos en el dashboard.
export const reconciliationEvents = new QueueEvents(QUEUE_NAMES.reconciliation, {
  connection: redis,
});

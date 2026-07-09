/**
 * Worker de BullMQ — procesa los jobs del Financial Sentinel.
 *
 * Se arranca en un proceso separado (o integrado en el API en dev).
 * Escucha las colas `reconciliation` y `bank-notification`.
 */
import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { QUEUE_NAMES, type BankNotificationJobData, type ReconciliationJobData } from './queues.js';
import { runReconciliation } from '../services/reconciliation.service.js';
import { processBankNotification } from '../services/sentinel.service.js';
import { getAdapters } from '../config/adapters.js';

export function startWorkers(): void {
  // Worker de reconciliación diaria.
  const reconciliationWorker = new Worker<ReconciliationJobData>(
    QUEUE_NAMES.reconciliation,
    async (job) => {
      console.log(`[Sentinel] Reconciliación para tenant ${job.data.tenantId} (${job.data.triggeredBy})`);
      const adapters = getAdapters();
      const result = await runReconciliation(job.data.tenantId, new Date(job.data.runDate), {
        qbo: adapters.qbo,
        plaid: adapters.plaid,
      });
      console.log(
        `[Sentinel] Reconciliación completa: ${result.reconciledCount} reconciliados, ${result.discrepancyCount} discrepancias, balanced=${result.balanced}`,
      );
      return result;
    },
    { connection: redis, concurrency: 2 },
  );

  // Worker de notificaciones bancarias (e-Transfer).
  const bankWorker = new Worker<BankNotificationJobData>(
    QUEUE_NAMES.bankNotification,
    async (job) => {
      console.log(
        `[Sentinel] e-Transfer procesando: ${job.data.amountCents / 100} CAD ref=${job.data.reference}`,
      );
      const result = await processBankNotification(job.data);
      console.log(
        `[Sentinel] e-Transfer resultado: decision=${result.decision} score=${result.score.toFixed(2)} lease=${result.matchedLeaseId ?? 'sin match'}`,
      );
      return result;
    },
    { connection: redis, concurrency: 4 },
  );

  reconciliationWorker.on('failed', (job, err) => {
    console.error(`[Sentinel] Job reconciliación falló (${job?.id}):`, err.message);
  });
  bankWorker.on('failed', (job, err) => {
    console.error(`[Sentinel] Job bancario falló (${job?.id}):`, err.message);
  });

  console.log('  ⚙️  Workers del Financial Sentinel arrancados (reconciliación + e-Transfer)');
}

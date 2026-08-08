/**
 * Worker de BullMQ — procesa los jobs del Financial Sentinel.
 *
 * Se arranca en un proceso separado (o integrado en el API en dev).
 * Escucha las colas `reconciliation` y `bank-notification`.
 */
import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import { QUEUE_NAMES, type BankNotificationJobData, type ReconciliationJobData, type RemarketingJobData } from './queues.js';
import { runReconciliation } from '../services/reconciliation.service.js';
import { processBankNotification } from '../services/sentinel.service.js';
import { getAdapters } from '../config/adapters.js';
import { prisma } from '../config/db.js';
import { runWeeklyReengagement } from '../services/remarketing.service.js';

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

  // Worker de reactivación semanal de leads (Fase 1B).
  const remarketingWorker = new Worker<RemarketingJobData>(
    QUEUE_NAMES.remarketing,
    async () => {
      const adapters = getAdapters();
      const tenants = await prisma.tenant.findMany({ select: { id: true } });
      let totalSent = 0;
      let totalSkipped = 0;
      let failedTenants = 0;
      for (const tenant of tenants) {
        // Fix 7: un tenant con un problema de datos específico no debe
        // tumbar la corrida completa — sin este try/catch, un throw aquí
        // propaga hasta BullMQ, que reintenta el JOB ENTERO hasta 3 veces
        // (defaultJobOptions.attempts en queues.ts), y si el tenant que
        // falla siempre falla, los tenants que vienen después de él en el
        // orden de iteración nunca se procesan en ninguno de los 3 intentos.
        try {
          const result = await runWeeklyReengagement(tenant.id, {
            glm: adapters.glm,
            messaging: adapters.messaging,
            isMockGlm: adapters.mockModes.glm,
          });
          totalSent += result.sent;
          totalSkipped += result.skipped;
        } catch (error) {
          failedTenants++;
          console.error(`[Remarketing] Tenant ${tenant.id} falló, se continúa con el resto:`, error);
        }
      }
      console.log(
        `[Remarketing] Corrida semanal: ${totalSent} enviados, ${totalSkipped} omitidos, ${tenants.length} tenants, ${failedTenants} tenants fallidos`,
      );
      return { totalSent, totalSkipped, failedTenants };
    },
    { connection: redis, concurrency: 1 },
  );

  reconciliationWorker.on('failed', (job, err) => {
    console.error(`[Sentinel] Job reconciliación falló (${job?.id}):`, err.message);
  });
  bankWorker.on('failed', (job, err) => {
    console.error(`[Sentinel] Job bancario falló (${job?.id}):`, err.message);
  });
  remarketingWorker.on('failed', (job, err) => {
    console.error(`[Remarketing] Job falló (${job?.id}):`, err.message);
  });

  console.log('  ⚙️  Workers arrancados (Financial Sentinel: reconciliación + e-Transfer; Remarketing: reactivación semanal)');
}

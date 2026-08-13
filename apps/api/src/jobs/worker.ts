/**
 * Worker de BullMQ — procesa los jobs del Financial Sentinel.
 *
 * Se arranca en un proceso separado (o integrado en el API en dev).
 * Escucha las colas `reconciliation` y `bank-notification`.
 */
import { Worker } from 'bullmq';
import { redis } from '../config/redis.js';
import {
  QUEUE_NAMES,
  type BankNotificationJobData,
  type ReconciliationJobData,
  type RemarketingJobData,
  type ScreeningPollJobData,
  type ScreeningRequestJobData,
} from './queues.js';
import { runReconciliation } from '../services/reconciliation.service.js';
import { processBankNotification } from '../services/sentinel.service.js';
import { getAdapters } from '../config/adapters.js';
import { prisma } from '../config/db.js';
import { runWeeklyReengagement } from '../services/remarketing.service.js';
import {
  markScreeningRequestFailed,
  markScreeningTimedOut,
  pollScreeningResult,
  runScreeningRequest,
} from '../services/screening.service.js';

/** Forma mínima de un job de BullMQ que necesitan los handlers de 'failed'. */
type FailedJobLike<TData> = {
  id?: string;
  data: TData;
  attemptsMade: number;
  opts: { attempts?: number };
  /**
   * Campo público de `Job` en BullMQ 5.x. Cuando el chequeo de jobs
   * atascados supera `maxStalledCount`, el script Lua
   * `moveStalledJobsToWait` NO falla el job ahí mismo: escribe el motivo en
   * el hash del job (campo `defa` → `deferredFailure`) y lo devuelve a
   * 'wait'. Al retomarlo, el worker ve ese campo y falla el job con un
   * `UnrecoverableError`.
   */
  deferredFailure?: string;
};

/**
 * ¿Este 'failed' fue el ÚLTIMO, o BullMQ todavía va a reintentar el job?
 *
 * BullMQ emite 'failed' en CADA intento fallido, no solo en el último, así
 * que sin este chequeo cerraríamos el checkeo en el primer tropiezo. El
 * criterio replica el que usa BullMQ internamente (`Job.shouldRetryJob` en
 * bullmq 5.79.3): NO hay reintento cuando se agotaron los intentos O
 * cuando el error es irrecuperable.
 *
 * Se decidió por el criterio general ("cualquier fallo sin reintento
 * pendiente es un cierre") en vez de detectar el caso "stalled" en
 * particular: un job atascado no es la única forma de terminar en 'failed'
 * con `attemptsMade` todavía bajo — cualquier `UnrecoverableError` (el
 * deferred failure del stalled, `maxStartedAttempts`) hace lo mismo, y
 * todas dejan el checkeo colgado igual. Detectar solo "stalled" arreglaría
 * un disparador y dejaría los otros abiertos, además de atarnos al texto
 * exacto del mensaje de BullMQ.
 */
export function isFinalJobFailure(
  job: { attemptsMade: number; opts: { attempts?: number }; deferredFailure?: string },
  err: Error,
): boolean {
  // Camino normal: se consumieron todos los intentos configurados
  // (`attemptsMade` ya viene incrementado cuando BullMQ emite 'failed').
  if (job.attemptsMade >= (job.opts.attempts ?? 0)) return true;
  // Irrecuperable: BullMQ no reintenta pase lo que pase (incluye el job
  // atascado, que llega aquí como UnrecoverableError con el motivo diferido).
  if (err.name === 'UnrecoverableError') return true;
  if (job.deferredFailure) return true;
  // Red de seguridad por si una versión distinta de BullMQ 5.x reporta el
  // job atascado como un Error común en vez de UnrecoverableError.
  if (/stalled more than allowable limit/i.test(err.message)) return true;
  return false;
}

/**
 * Lógica pura detrás del listener 'failed' del worker de sondeo — separada
 * de `startWorkers()` para poder probarla con un job-like de mentiras, sin
 * levantar un Worker de BullMQ real. `job` puede venir `undefined` en el
 * caso raro en que BullMQ dispara 'failed' sin un job asociado.
 *
 * Si nadie actúa cuando ya no habrá reintento, el checkeo se queda en
 * 'pending' para siempre y nadie se entera: el silent-failure exacto que la
 * constraint global 1 del proyecto prohíbe.
 */
export async function handleScreeningPollFailure(
  job: FailedJobLike<ScreeningPollJobData> | undefined,
  err: Error,
): Promise<void> {
  console.error(`[Screening] Job de sondeo falló/sigue pendiente (${job?.id}):`, err.message);
  if (!job) return;
  if (!isFinalJobFailure(job, err)) return; // todavía va a reintentar — camino normal.

  try {
    await markScreeningTimedOut(job.data.applicationId, job.data.tenantId, job.data.kind);
  } catch (timeoutErr) {
    console.error(`[Screening] No se pudo cerrar el sondeo agotado (${job.id}):`, timeoutErr);
  }
}

/**
 * Simétrica de `handleScreeningPollFailure`, para la cola de SOLICITUD.
 *
 * Camino real de falla que esto cubre: `runCheck` devuelve 'pending', se
 * guarda el providerRef, y el `screeningPollQueue.add()` que sigue revienta
 * (Redis parpadeando). BullMQ reintenta el job completo; la rama de
 * idempotencia de `runScreeningRequest` reencola el sondeo sin repetir
 * `runCheck` — pero si Redis sigue caído, ese enqueue falla en los tres
 * intentos y el checkeo se queda en 'pending' sin ningún job detrás. Lo
 * mismo si el adapter revienta en los tres intentos: queda en 'requested'.
 */
export async function handleScreeningRequestFailure(
  job: FailedJobLike<ScreeningRequestJobData> | undefined,
  err: Error,
): Promise<void> {
  console.error(`[Screening] Job de solicitud falló (${job?.id}):`, err.message);
  if (!job) return;
  if (!isFinalJobFailure(job, err)) return;

  try {
    await markScreeningRequestFailed(job.data.applicationId, job.data.tenantId, job.data.kind);
  } catch (closeErr) {
    console.error(`[Screening] No se pudo cerrar la solicitud agotada (${job.id}):`, closeErr);
  }
}

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

  // Workers de screening (Fase 2.2): request envía al adapter, poll sondea
  // hasta que el resultado deja de estar 'pending'.
  const screeningRequestWorker = new Worker<ScreeningRequestJobData>(
    QUEUE_NAMES.screeningRequest,
    async (job) => {
      await runScreeningRequest(job.data.applicationId, job.data.tenantId, job.data.kind, job.data.forceMock ?? false);
    },
    // `attempts: 1` (en queues.ts) evita que un fallo de `runCheck` se
    // reintente y cobre dos veces — pero BullMQ tiene un camino aparte que no
    // consulta `attempts`: si el worker muere a mitad de la corrida (Playwright,
    // 60-90s), el job queda 'active' y BullMQ lo mueve de vuelta a 'wait' y lo
    // re-despacha ("stalled"), lo que puede producir un segundo cargo real de
    // $18.99. Con `maxStalledCount: 0`, el primer stall detectado se cierra
    // como `UnrecoverableError` en vez de re-despacharse — ese camino ya lo
    // maneja `handleScreeningRequestFailure`/`isFinalJobFailure` arriba.
    { connection: redis, maxStalledCount: 0 },
  );

  const screeningPollWorker = new Worker<ScreeningPollJobData>(
    QUEUE_NAMES.screeningPoll,
    async (job) => {
      const { done } = await pollScreeningResult(
        job.data.applicationId, job.data.tenantId, job.data.kind, job.data.providerRef,
      );
      if (!done) {
        // BullMQ ya reintenta según defaultJobOptions.attempts/backoff de la
        // cola — lanzar aquí hace que el job se reintente con el backoff
        // configurado (15 min fijos) en vez de completarse prematuramente.
        throw new Error('Screening result still pending');
      }
    },
    { connection: redis },
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
  screeningRequestWorker.on('failed', (job, err) => {
    void handleScreeningRequestFailure(job, err);
  });
  screeningPollWorker.on('failed', (job, err) => {
    void handleScreeningPollFailure(job, err);
  });

  console.log('  ⚙️  Workers arrancados (Financial Sentinel: reconciliación + e-Transfer; Remarketing: reactivación semanal; Screening: crédito + antecedentes)');
}

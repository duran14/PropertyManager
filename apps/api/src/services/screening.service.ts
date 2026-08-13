/**
 * Orquesta los dos checkeos de screening (crédito, antecedentes penales):
 * disparo tras consentimiento, envío al adapter, sondeo del resultado.
 */
import type { ScreeningCheckKind } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { buildDocumentStorageKey, createLocalDocumentStorage, decodeBase64Payload } from './document-storage.service.js';
import { notifyStaffTargets, resolveStaffNotifyTargets, type NotifiableStaff } from './staff-notify.service.js';
import { screeningPollQueue, screeningRequestQueue } from '../jobs/queues.js';

const STATUS_FIELD: Record<ScreeningCheckKind, 'creditCheckStatus' | 'criminalCheckStatus'> = {
  credit: 'creditCheckStatus',
  criminal: 'criminalCheckStatus',
};
const SUMMARY_FIELD: Record<ScreeningCheckKind, 'creditCheckSummary' | 'criminalCheckSummary'> = {
  credit: 'creditCheckSummary',
  criminal: 'criminalCheckSummary',
};
const REPORT_KEY_FIELD: Record<ScreeningCheckKind, 'creditCheckReportKey' | 'criminalCheckReportKey'> = {
  credit: 'creditCheckReportKey',
  criminal: 'criminalCheckReportKey',
};
const PROVIDER_REF_FIELD: Record<ScreeningCheckKind, 'creditCheckProviderRef' | 'criminalCheckProviderRef'> = {
  credit: 'creditCheckProviderRef',
  criminal: 'criminalCheckProviderRef',
};
const COMPLETED_AT_FIELD: Record<ScreeningCheckKind, 'creditCheckCompletedAt' | 'criminalCheckCompletedAt'> = {
  credit: 'creditCheckCompletedAt',
  criminal: 'criminalCheckCompletedAt',
};

/**
 * Al enviarse la aplicación, dispara ambos checkeos si (y solo si) el
 * prospecto dio los dos consentimientos requeridos. Sin consentimiento no
 * hay nada que hacer — no es un error, es el caso normal cuando el
 * prospecto optó por no autorizarlo.
 */
export async function triggerScreeningIfConsented(applicationId: string, tenantId: string): Promise<void> {
  const application = await prisma.rentalApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { consentCreditCheckAt: true, consentPoliceCheckAt: true },
  });
  if (!application || !application.consentCreditCheckAt || !application.consentPoliceCheckAt) return;

  const now = new Date();
  await prisma.rentalApplication.update({
    where: { id: applicationId },
    data: {
      creditCheckStatus: 'requested',
      creditCheckRequestedAt: now,
      criminalCheckStatus: 'requested',
      criminalCheckRequestedAt: now,
    },
  });

  // Promise.allSettled, NO dos `await` secuenciales: con `await` secuencial,
  // si el enqueue de 'credit' revienta, 'criminal' nunca llega a intentarse
  // — y el update de arriba ya dejó ambos como 'requested' en la BD. Cada
  // kind se resuelve de forma independiente; el que falle al encolarse se
  // cierra como 'failed' de inmediato en vez de quedar 'requested' sin
  // ningún job detrás (el mismo estado atorado y silencioso que el sondeo
  // agotado evita más abajo).
  const kinds: ScreeningCheckKind[] = ['credit', 'criminal'];
  const enqueued = await Promise.allSettled(
    kinds.map((kind) => screeningRequestQueue.add('run-screening-request', { tenantId, applicationId, kind })),
  );

  await Promise.all(
    enqueued.map(async (settled, index) => {
      if (settled.status === 'fulfilled') return;
      const kind = kinds[index];
      console.error(`[Screening] No se pudo encolar el checkeo de ${kind} para ${applicationId}:`, settled.reason);
      await persistTerminalResult(applicationId, tenantId, kind, {
        status: 'failed',
        reason: 'Could not schedule the screening check',
      });
    }),
  );
}

/**
 * Envía la solicitud al adapter de screening. Casi siempre vuelve
 * 'pending' (mecanismo de navegador asíncrono) y agenda el primer sondeo;
 * si el adapter resuelve de inmediato, persiste el resultado terminal.
 */
export async function runScreeningRequest(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
): Promise<void> {
  const application = await prisma.rentalApplication.findFirstOrThrow({
    where: { id: applicationId, tenantId },
  });

  // Idempotencia: `screeningRequestQueue` reintenta el job completo hasta 3
  // veces (defaultJobOptions.attempts en queues.ts). Si `runCheck` ya tuvo
  // éxito en un intento anterior — quedó un providerRef guardado — y lo que
  // falló fue el paso siguiente (el update de abajo o el enqueue del
  // sondeo), un reintento NO puede volver a llamar `runCheck`: eso
  // dispararía una SEGUNDA solicitud real al buró de crédito/antecedentes
  // para el mismo solicitante. Basta con re-agendar el sondeo con la
  // referencia que ya existe.
  const existingProviderRef = application[PROVIDER_REF_FIELD[kind]];
  if (existingProviderRef) {
    await screeningPollQueue.add(
      'poll-screening-result',
      { tenantId, applicationId, kind, providerRef: existingProviderRef },
      { delay: 15 * 60_000 },
    );
    return;
  }

  const { getAdapters } = await import('../config/adapters.js');
  const result = await getAdapters().screening.runCheck(kind, {
    fullName: application.applicantFullName ?? '',
    dateOfBirth: application.dateOfBirth?.toISOString().slice(0, 10) ?? '',
    currentAddress: application.currentAddress ?? '',
    currentCity: application.currentCity ?? '',
    currentProvince: application.currentProvince ?? '',
    currentPostalCode: application.currentPostalCode ?? '',
  });

  if (result.status === 'pending') {
    await prisma.rentalApplication.update({
      where: { id: applicationId },
      data: { [STATUS_FIELD[kind]]: 'pending', [PROVIDER_REF_FIELD[kind]]: result.providerRef },
    });
    await screeningPollQueue.add(
      'poll-screening-result',
      { tenantId, applicationId, kind, providerRef: result.providerRef },
      { delay: 15 * 60_000 },
    );
    return;
  }

  await persistTerminalResult(applicationId, tenantId, kind, result);
}

/**
 * Sondea el resultado de un envío 'pending'. Devuelve `done: false`
 * mientras el proveedor sigue procesando — el worker vuelve a intentar
 * según el backoff de `screeningPollQueue` (Step 6 en worker.ts).
 */
export async function pollScreeningResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  providerRef: string,
): Promise<{ done: boolean }> {
  const { getAdapters } = await import('../config/adapters.js');
  const result = await getAdapters().screening.pollResult(kind, providerRef);

  if (result.status === 'pending') return { done: false };

  await persistTerminalResult(applicationId, tenantId, kind, result);
  return { done: true };
}

/**
 * Se llama cuando `screeningPollQueue` agota sus reintentos (10 intentos,
 * ~2.5h a backoff fijo de 15 min — ver queues.ts) sin que el proveedor haya
 * dado un resultado terminal. Reutiliza `persistTerminalResult` — la MISMA
 * vía que cualquier otro resultado 'failed' del adapter — para no tener dos
 * formas distintas de "cómo se marca un checkeo como fallido" que puedan
 * divergir entre sí.
 */
export async function markScreeningTimedOut(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
): Promise<void> {
  await persistTerminalResult(applicationId, tenantId, kind, {
    status: 'failed',
    reason: 'Screening result did not arrive after multiple attempts',
  });
}

async function persistTerminalResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  result: { status: 'completed'; verdict: 'passed' | 'flagged'; summary: string; reportBase64: string; reportMimeType: string }
    | { status: 'failed'; reason: string },
): Promise<void> {
  if (result.status === 'failed') {
    // Un fallo del adapter (login fallido, timeout, portal caído) SIEMPRE se
    // traduce en 'failed' con aviso al staff, nunca en un resultado
    // inventado ni en silencio (no-negociable del proyecto).
    await prisma.rentalApplication.update({
      where: { id: applicationId },
      data: {
        [STATUS_FIELD[kind]]: 'failed',
        [SUMMARY_FIELD[kind]]: result.reason,
        [COMPLETED_AT_FIELD[kind]]: new Date(),
      },
    });
    await notifyScreeningResult(applicationId, tenantId, kind, 'failed');
    return;
  }

  const env = getEnv();
  const storage = createLocalDocumentStorage({
    rootDir: env.DOCUMENT_STORAGE_DIR,
    publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined,
  });
  const stored = await storage.putObject({
    key: buildDocumentStorageKey({
      tenantId, documentId: `${applicationId}-${kind}`, filename: `${kind}-report.pdf`,
    }),
    body: decodeBase64Payload(result.reportBase64),
    contentType: result.reportMimeType,
  });

  await prisma.rentalApplication.update({
    where: { id: applicationId },
    data: {
      [STATUS_FIELD[kind]]: result.verdict,
      [SUMMARY_FIELD[kind]]: result.summary,
      [REPORT_KEY_FIELD[kind]]: stored.storageKey,
      [COMPLETED_AT_FIELD[kind]]: new Date(),
    },
  });
  await notifyScreeningResult(applicationId, tenantId, kind, result.verdict);
}

/**
 * Best-effort, igual que notifyStaffOfApplication (Fase 2A): el resultado
 * ya quedó guardado, un fallo de notificación no debe propagarse.
 */
async function notifyScreeningResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  outcome: 'passed' | 'flagged' | 'failed',
): Promise<void> {
  try {
    const application = await prisma.rentalApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: { showing: { select: { brokerUserId: true } }, lead: { select: { assignedUserId: true, name: true } } },
    });
    const staff = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, email: true, role: true, notificationChannel: true, notificationAddress: true },
    });
    const targets: NotifiableStaff[] = resolveStaffNotifyTargets({
      brokerUserId: application.showing.brokerUserId,
      assignedUserId: application.lead.assignedUserId,
      staff,
      propertyManagerIds: staff.filter((member) => member.role === 'property_manager').map((member) => member.id),
    });

    const checkLabel = kind === 'credit' ? 'Credit check' : 'Criminal record check';
    const outcomeText = outcome === 'failed'
      ? 'could not be completed'
      : outcome === 'flagged'
        ? 'came back flagged for review'
        : 'came back clear';
    const link = `${getEnv().WEB_URL}/showings`;
    const body = `${checkLabel} for ${application.lead.name ?? 'a lead'} ${outcomeText}.\n\n${link}`;

    const { getAdapters } = await import('../config/adapters.js');
    await notifyStaffTargets({
      targets, subject: `${checkLabel} result ready`, body, messaging: getAdapters().messaging,
    });
  } catch (error) {
    console.error(`[Screening] No se pudo notificar el resultado de ${applicationId}:`, error);
  }
}

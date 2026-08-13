/**
 * Orquesta los dos checkeos de screening (crédito, antecedentes penales):
 * disparo tras consentimiento, envío al adapter, sondeo del resultado.
 */
import type { ScreeningCheckKind } from '@property-manager/adapters';
import { FrontLobbyScreeningAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { buildDocumentStorageKey, createLocalDocumentStorage, decodeBase64Payload } from './document-storage.service.js';
import { notifyStaffTargets, resolveStaffNotifyTargets, type NotifiableStaff } from './staff-notify.service.js';
import { screeningPollQueue, screeningRequestQueue } from '../jobs/queues.js';
import { getIntegrationCredentials, type ScreeningProvider } from './integration-vault.service.js';

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
 * Estados desde los que un checkeo TODAVÍA puede recibir un resultado
 * terminal. Sirve de guard en `persistTerminalResult`: una vez que el
 * checkeo llegó a 'passed'/'flagged'/'failed', ninguna cadena de jobs
 * rezagada puede pisarlo (ver más abajo).
 */
const OPEN_STATUSES = ['requested', 'pending'] as const;

/**
 * Mientras el tenant no tenga credenciales de FrontLobby/Sterling
 * conectadas en la bóveda (ver `getScreeningAdapter` más abajo), el
 * checkeo corre contra `ScreeningMockAdapter`. Ese mock devuelve
 * veredictos con pinta de reales ("Score 740, no collections"), y si esto
 * se despliega tal cual, un manager podría arrendar creyendo que un dato
 * inventado es un buró de crédito de verdad.
 *
 * Por eso todo resultado COMPLETADO (passed/flagged) producido por el mock
 * se marca con este prefijo, tanto en el summary que se guarda como en el
 * aviso al staff. El status del enum NO cambia — lo que cambia es que el
 * texto ya no se puede confundir con un resultado real. Un 'failed' no se
 * marca: ahí no hay ningún veredicto fabricado que pueda engañar a nadie,
 * solo el motivo por el que no se pudo completar.
 */
const SIMULATED_PREFIX = '[SIMULATED] ';

const PROVIDER_BY_KIND: Record<ScreeningCheckKind, ScreeningProvider> = {
  credit: 'frontlobby_portal',
  criminal: 'sterling_portal',
};

const MANUAL_UPLOAD_MIN_CONFIDENCE = 0.5;

/**
 * Registra un reporte de screening que el staff obtuvo por fuera de esta
 * app (de cualquier proveedor) y subió manualmente. A diferencia de
 * `persistTerminalResult`, esto NO respeta el guard de `OPEN_STATUSES`: es
 * una acción humana explícita, no una escritura automática rezagada, así
 * que puede registrar un resultado sin importar el estado actual del
 * checkeo (incluso sobreescribir uno ya cerrado). Si más tarde una cadena
 * automática intenta su propio cierre vía `persistTerminalResult`, el
 * guard de esa función ya existente (`WHERE ... IN ('requested','pending')`)
 * no encuentra la fila y descarta la escritura en silencio -- las dos
 * funciones componen de forma segura sin necesidad de coordinarse.
 */
export async function recordManualScreeningReport(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  upload: { mimeType: string; base64: string; filename?: string },
): Promise<{ ok: true; verdict: 'passed' | 'flagged' } | { ok: false; status: 400 | 404; error: string }> {
  const application = await prisma.rentalApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { id: true },
  });
  if (!application) return { ok: false, status: 404, error: 'Application not found' };

  const { getAdapters } = await import('../config/adapters.js');
  const extraction = await getAdapters().glm.extractScreeningReport({
    mimeType: upload.mimeType, base64: upload.base64, filename: upload.filename, kind,
  });
  if (extraction.verdict === null || extraction.confidence < MANUAL_UPLOAD_MIN_CONFIDENCE) {
    return { ok: false, status: 400, error: 'Could not determine a verdict from this report — review it manually' };
  }

  const env = getEnv();
  const storage = createLocalDocumentStorage({
    rootDir: env.DOCUMENT_STORAGE_DIR,
    publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined,
  });
  const stored = await storage.putObject({
    key: buildDocumentStorageKey({ tenantId, documentId: `${applicationId}-${kind}`, filename: `${kind}-report.pdf` }),
    body: decodeBase64Payload(upload.base64),
    contentType: upload.mimeType,
  });

  const now = new Date();
  await prisma.rentalApplication.updateMany({
    where: { id: applicationId, tenantId },
    data: {
      [STATUS_FIELD[kind]]: extraction.verdict,
      [SUMMARY_FIELD[kind]]: `[AUTOMATED] ${extraction.summaryText}`,
      [REPORT_KEY_FIELD[kind]]: stored.storageKey,
      [COMPLETED_AT_FIELD[kind]]: now,
    },
  });
  return { ok: true, verdict: extraction.verdict };
}

/**
 * Resuelve el adapter real por `kind` si el tenant tiene credenciales
 * conectadas en la bóveda; si no, cae al mock del factory global — el mismo
 * camino de hoy, sin cambios. Vive aquí (no en `factory.ts`/`getAdapters()`)
 * porque necesita leer la bóveda por tenant, y `getAdapters()` es síncrono
 * y cacheado una sola vez por proceso sin `tenantId` — 64 call sites en el
 * resto de la app dependen de que siga siendo así.
 */
async function getScreeningAdapter(tenantId: string, kind: ScreeningCheckKind) {
  const credentials = await getIntegrationCredentials(tenantId, PROVIDER_BY_KIND[kind]);
  if (credentials && kind === 'credit') {
    const { getAdapters } = await import('../config/adapters.js');
    return new FrontLobbyScreeningAdapter(credentials, getAdapters().glm);
  }
  const { getAdapters } = await import('../config/adapters.js');
  return getAdapters().screening; // mock — Sterling real todavía no existe, credit sin credenciales cae aquí también
}

async function isMockScreening(tenantId: string, kind: ScreeningCheckKind): Promise<boolean> {
  const adapter = await getScreeningAdapter(tenantId, kind);
  return adapter.name === 'screening_mock';
}

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
  // Real (credenciales de FrontLobby/Sterling conectadas) nunca se
  // dispara solo: cada corrida real de crédito cuesta $18.99, así que
  // queda 'awaiting_approval' hasta que un property_manager/broker lo
  // apruebe explícitamente (ver `approveScreening`). El mock (sin
  // credenciales, o antecedentes penales hasta que exista Sterling) sigue
  // yendo directo a 'requested' — comportamiento de hoy, sin cambios.
  const kinds: ScreeningCheckKind[] = ['credit', 'criminal'];
  const initialStatusByKind = await Promise.all(
    kinds.map(async (kind) =>
      (await isMockScreening(tenantId, kind)) ? ('requested' as const) : ('awaiting_approval' as const),
    ),
  );

  await prisma.rentalApplication.update({
    where: { id: applicationId },
    data: {
      creditCheckStatus: initialStatusByKind[0],
      creditCheckRequestedAt: now,
      criminalCheckStatus: initialStatusByKind[1],
      criminalCheckRequestedAt: now,
    },
  });

  // Promise.allSettled, NO dos `await` secuenciales: con `await` secuencial,
  // si el enqueue de 'credit' revienta, 'criminal' nunca llega a intentarse
  // — y el update de arriba ya dejó ambos en su estado inicial en la BD.
  // Cada kind se resuelve de forma independiente; el que falle al
  // encolarse se cierra como 'failed' de inmediato en vez de quedar
  // 'requested' sin ningún job detrás (el mismo estado atorado y
  // silencioso que el sondeo agotado evita más abajo). Solo se encolan los
  // kinds que quedaron 'requested' — los 'awaiting_approval' esperan a
  // `approveScreening`.
  const kindsToEnqueue = kinds.filter((_, index) => initialStatusByKind[index] === 'requested');
  const enqueued = await Promise.allSettled(
    kindsToEnqueue.map((kind) =>
      // forceMock: true — esta decisión ya se tomó como mock arriba; el job
      // debe honrarla en vez de volver a resolver el adapter cuando corra
      // (ver el comentario de `forceMock` en `runScreeningRequest`).
      screeningRequestQueue.add('run-screening-request', { tenantId, applicationId, kind, forceMock: true }),
    ),
  );

  await Promise.all(
    enqueued.map(async (settled, index) => {
      if (settled.status === 'fulfilled') return;
      const kind = kindsToEnqueue[index]!;
      console.error(`[Screening] No se pudo encolar el checkeo de ${kind} para ${applicationId}:`, settled.reason);
      await persistTerminalResult(applicationId, tenantId, kind, {
        status: 'failed',
        reason: 'Could not schedule the screening check',
      }, false); // isSimulated: ignorado en la rama 'failed', no hay prefijo que decidir.
    }),
  );

  const kindsAwaitingApproval = kinds.filter((_, index) => initialStatusByKind[index] === 'awaiting_approval');
  if (kindsAwaitingApproval.length > 0) {
    await notifyApprovalNeeded(applicationId, tenantId, kindsAwaitingApproval);
  }
}

/**
 * Best-effort, mismo patrón que `notifyScreeningResult`: el estado ya
 * quedó guardado como 'awaiting_approval', un fallo de notificación no
 * debe propagarse — el staff igual puede ver el botón de aprobar en
 * Showings sin haber recibido el aviso.
 */
async function notifyApprovalNeeded(applicationId: string, tenantId: string, kinds: ScreeningCheckKind[]): Promise<void> {
  try {
    const application = await prisma.rentalApplication.findFirstOrThrow({
      where: { id: applicationId, tenantId },
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
    const labels = kinds.map((kind) => (kind === 'credit' ? 'Credit check ($18.99)' : 'Criminal record check')).join(', ');
    const link = `${getEnv().WEB_URL}/showings`;
    const body = `${labels} for ${application.lead.name ?? 'a lead'} is ready to run — approve the real charge in Showings.\n\n${link}`;
    const { getAdapters } = await import('../config/adapters.js');
    await notifyStaffTargets({ targets, subject: 'Screening approval needed', body, messaging: getAdapters().messaging });
  } catch (error) {
    console.error(`[Screening] No se pudo notificar la aprobación pendiente de ${applicationId}:`, error);
  }
}

/**
 * Aprueba un checkeo real que quedó 'awaiting_approval' (cargo real de
 * $18.99 en el caso de crédito) y recién ahí lo encola. El `updateMany`
 * con guard de estado en el `where` (no `update` por `id`) evita el doble
 * cobro: dos clics simultáneos en el botón de aprobar solo logran que uno
 * de los dos afecte una fila (count === 1), el otro ve count === 0 y
 * devuelve `ok:false` sin encolar una segunda vez.
 */
export async function approveScreening(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { count } = await prisma.rentalApplication.updateMany({
    where: { id: applicationId, tenantId, [STATUS_FIELD[kind]]: 'awaiting_approval' },
    data: { [STATUS_FIELD[kind]]: 'requested' },
  });
  if (count === 0) {
    return { ok: false, reason: 'Not awaiting approval' };
  }
  try {
    // `attempts: 1` sobreescribe el `defaultJobOptions.attempts: 3` de
    // `screeningRequestQueue` SOLO para este job (BullMQ 5.79.3 hace
    // `{...jobsOpts, ...opts}` en `Queue.addJob`, así que el resto de las
    // opciones por defecto — backoff, removeOnComplete/Fail — se conservan).
    //
    // El motivo es económico, no técnico: el guard de idempotencia de
    // `runScreeningRequest` solo protege si `runCheck` ya alcanzó a persistir
    // el providerRef. Si el worker muere (crash, deploy, OOM) o el job se
    // queda "stalled" durante los ~60-90s que tarda la navegación real de
    // Playwright, un reintento automático volvería a llamar `runCheck` desde
    // cero: un SEGUNDO cargo real de $18.99 con una sola aprobación humana de
    // por medio. Fallar cuesta $0 y el listener 'failed' del worker ya cierra
    // el checkeo como 'failed' (`handleScreeningRequestFailure`); reintentar
    // solo puede costar dinero duplicado. Si un humano quiere reintentar,
    // vuelve a aprobar a mano — nunca automáticamente.
    //
    // El `.add(...)` del mock (`triggerScreeningIfConsented`) NO lleva esto:
    // ese camino es gratis y sus 3 intentos son puro beneficio.
    await screeningRequestQueue.add('run-screening-request', { tenantId, applicationId, kind }, { attempts: 1 });
  } catch (error) {
    console.error(`[Screening] No se pudo encolar el checkeo de ${kind} tras aprobación (${applicationId}):`, error);
    await persistTerminalResult(applicationId, tenantId, kind, {
      status: 'failed',
      reason: 'Could not schedule the screening check',
    }, false); // isSimulated: ignorado en la rama 'failed', no hay prefijo que decidir.
  }
  return { ok: true };
}

/**
 * Envía la solicitud al adapter de screening. Casi siempre vuelve
 * 'pending' (mecanismo de navegador asíncrono) y agenda el primer sondeo;
 * si el adapter resuelve de inmediato, persiste el resultado terminal.
 *
 * `forceMock`: cierra una ventana de carrera entre `triggerScreeningIfConsented`
 * (que decide UNA VEZ si el checkeo es mock o real, y encola sin delay
 * cuando es mock) y este job, que puede correr más tarde. Si un
 * property_manager guarda credenciales reales de FrontLobby justo en esa
 * ventana, una segunda resolución del adapter aquí correría el checkeo
 * REAL — con cargo de $18.99 — sin haber pasado nunca por
 * 'awaiting_approval'/`approveScreening`. Cuando el trigger automático ya
 * decidió mock, `forceMock: true` viaja en el job y este código usa
 * SIEMPRE el mock, sin volver a consultar la bóveda. `approveScreening` no
 * manda este flag: ahí la resolución ocurre justo al momento de la
 * aprobación humana, con las credenciales vigentes en ese instante — no
 * hay ventana que cerrar.
 */
export async function runScreeningRequest(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  forceMock: boolean = false,
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
    // No se puede volver a resolver el adapter aquí (no se llama runCheck,
    // por idempotencia), así que la única fuente de verdad de si ESTE
    // providerRef es del mock es el `forceMock` con el que corrió el intento
    // que lo generó -- se propaga tal cual al job de sondeo.
    await screeningPollQueue.add(
      'poll-screening-result',
      { tenantId, applicationId, kind, providerRef: existingProviderRef, forceMock },
      { delay: 15 * 60_000 },
    );
    return;
  }

  const adapter = forceMock
    ? (await import('../config/adapters.js')).getAdapters().screening
    : await getScreeningAdapter(tenantId, kind);
  const isSimulated = adapter.name === 'screening_mock';
  const result = await adapter.runCheck(kind, {
    fullName: application.applicantFullName ?? '',
    firstName: application.applicantFirstName ?? '',
    lastName: application.applicantLastName ?? '',
    dateOfBirth: application.dateOfBirth?.toISOString().slice(0, 10) ?? '',
    currentAddress: application.currentAddress ?? '',
    currentCity: application.currentCity ?? '',
    currentProvince: application.currentProvince ?? '',
    currentPostalCode: application.currentPostalCode ?? '',
    currentAddressStartDate: application.currentAddressStartDateAt?.toISOString().slice(0, 10) ?? '',
  });

  if (result.status === 'pending') {
    await prisma.rentalApplication.update({
      where: { id: applicationId },
      data: { [STATUS_FIELD[kind]]: 'pending', [PROVIDER_REF_FIELD[kind]]: result.providerRef },
    });
    // `isSimulated` (no el `forceMock` recibido) es lo que se propaga: es la
    // decisión REAL que se acaba de tomar resolviendo el adapter arriba, y
    // cubre también el camino de `approveScreening` (que no manda
    // `forceMock`) cuando ese adapter resulta ser el mock igual.
    await screeningPollQueue.add(
      'poll-screening-result',
      { tenantId, applicationId, kind, providerRef: result.providerRef, forceMock: isSimulated },
      { delay: 15 * 60_000 },
    );
    return;
  }

  await persistTerminalResult(applicationId, tenantId, kind, result, isSimulated);
}

/**
 * Sondea el resultado de un envío 'pending'. Devuelve `done: false`
 * mientras el proveedor sigue procesando — el worker vuelve a intentar
 * según el backoff de `screeningPollQueue` (Step 6 en worker.ts).
 *
 * `forceMock`: mismo cierre de ventana de carrera que en `runScreeningRequest`
 * (ver el comentario ahí), pero para el sondeo. Este job se encola con
 * `delay: 15 * 60_000` -- 15 minutos, una ventana mucho más larga que la del
 * envío inicial -- así que sin esto, credenciales reales de FrontLobby
 * guardadas mientras el sondeo espera harían que se re-resuelva el adapter
 * real y se le pase una referencia `mock_*` que no puede interpretar.
 */
export async function pollScreeningResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  providerRef: string,
  forceMock: boolean = false,
): Promise<{ done: boolean }> {
  const adapter = forceMock
    ? (await import('../config/adapters.js')).getAdapters().screening
    : await getScreeningAdapter(tenantId, kind);
  const isSimulated = adapter.name === 'screening_mock';
  const result = await adapter.pollResult(kind, providerRef);

  if (result.status === 'pending') return { done: false };

  await persistTerminalResult(applicationId, tenantId, kind, result, isSimulated);
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
  }, false); // isSimulated: ignorado en la rama 'failed', no hay prefijo que decidir.
}

/**
 * Simétrica de `markScreeningTimedOut`, pero para la etapa de SOLICITUD:
 * `screeningRequestQueue` agotó sus 3 intentos sin lograr dejar el checkeo
 * encaminado (el adapter reventó en los tres, o el enqueue del sondeo que
 * viene después falló siempre). Sin esto, el checkeo se queda en
 * 'requested'/'pending' para siempre y nadie se entera — el mismo
 * silent-failure que el sondeo agotado ya evita.
 *
 * El motivo es distinto y honesto: aquí el resultado no "no llegó", es que
 * nunca se llegó a pedir. Reutiliza `persistTerminalResult` — el único
 * punto de escritura de resultado terminal — igual que el timeout de sondeo.
 */
export async function markScreeningRequestFailed(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
): Promise<void> {
  await persistTerminalResult(applicationId, tenantId, kind, {
    status: 'failed',
    reason: 'Could not submit the screening request after multiple attempts',
  }, false); // isSimulated: ignorado en la rama 'failed', no hay prefijo que decidir.
}

/**
 * ÚNICO punto de escritura de un resultado terminal de screening (real, por
 * timeout, o por agotamiento de reintentos). Dos guards en el `where` de
 * ambas ramas, por eso `updateMany` y no `update`:
 *
 *  - `tenantId`: aislamiento de tenant en la ESCRITURA, igual que ya lo
 *    tienen las lecturas de este archivo. `update` por `id` a secas escribe
 *    en la fila sin importar de quién sea.
 *  - estado todavía abierto ('requested'/'pending'): si dos cadenas de
 *    jobs llegan a coexistir para el mismo `kind` (la rama de idempotencia
 *    de `runScreeningRequest` reencola el sondeo en cada reintento, y un job
 *    "stalled" puede revivir), el cierre tardío de una cadena vieja pisaría
 *    el veredicto real que ya persistió la otra — y encima notificaría al
 *    staff lo contrario de lo que pasó. Con el guard, la escritura tardía
 *    afecta 0 filas y no se notifica nada.
 *
 * `isSimulated`: quien llama ya tomó (o heredó) la decisión de si este
 * resultado vino del mock -- se usa tal cual para el prefijo `[SIMULATED]`
 * de abajo, en vez de volver a resolver el adapter contra la bóveda aquí.
 * Re-resolver en este punto tiene la misma ventana de carrera que
 * `runScreeningRequest`/`pollScreeningResult` ya cierran: si se guardan
 * credenciales reales entre el envío/sondeo y este cierre, un veredicto que
 * en realidad vino del mock se guardaría sin el prefijo.
 */
async function persistTerminalResult(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  result: { status: 'completed'; verdict: 'passed' | 'flagged'; summary: string; reportBase64: string; reportMimeType: string }
    | { status: 'failed'; reason: string },
  isSimulated: boolean,
): Promise<void> {
  if (result.status === 'failed') {
    // Un fallo del adapter (login fallido, timeout, portal caído) SIEMPRE se
    // traduce en 'failed' con aviso al staff, nunca en un resultado
    // inventado ni en silencio (no-negociable del proyecto).
    const { count } = await prisma.rentalApplication.updateMany({
      where: { id: applicationId, tenantId, [STATUS_FIELD[kind]]: { in: OPEN_STATUSES } },
      data: {
        [STATUS_FIELD[kind]]: 'failed',
        [SUMMARY_FIELD[kind]]: result.reason,
        [COMPLETED_AT_FIELD[kind]]: new Date(),
      },
    });
    if (count === 0) {
      console.warn(`[Screening] Resultado tardío ignorado (${kind} de ${applicationId} ya estaba cerrado)`);
      return;
    }
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

  const summary = isSimulated
    ? `${SIMULATED_PREFIX}${result.summary}`
    : result.summary;

  const { count } = await prisma.rentalApplication.updateMany({
    where: { id: applicationId, tenantId, [STATUS_FIELD[kind]]: { in: OPEN_STATUSES } },
    data: {
      [STATUS_FIELD[kind]]: result.verdict,
      [SUMMARY_FIELD[kind]]: summary,
      [REPORT_KEY_FIELD[kind]]: stored.storageKey,
      [COMPLETED_AT_FIELD[kind]]: new Date(),
    },
  });
  if (count === 0) {
    console.warn(`[Screening] Veredicto tardío ignorado (${kind} de ${applicationId} ya estaba cerrado)`);
    return;
  }
  await notifyScreeningResult(applicationId, tenantId, kind, result.verdict, isSimulated);
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
  isSimulated: boolean = false,
): Promise<void> {
  try {
    const application = await prisma.rentalApplication.findFirstOrThrow({
      where: { id: applicationId, tenantId },
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
    // Misma marca que el summary persistido: si el veredicto lo fabricó el
    // mock, el correo/mensaje al staff tampoco puede parecer real. Solo los
    // veredictos (passed/flagged) se marcan — un 'failed' no afirma nada
    // sobre el solicitante.
    const prefix = outcome !== 'failed' && isSimulated ? SIMULATED_PREFIX : '';
    const body = `${prefix}${checkLabel} for ${application.lead.name ?? 'a lead'} ${outcomeText}.\n\n${link}`;

    const { getAdapters } = await import('../config/adapters.js');
    await notifyStaffTargets({
      targets, subject: `${prefix}${checkLabel} result ready`, body, messaging: getAdapters().messaging,
    });
  } catch (error) {
    console.error(`[Screening] No se pudo notificar el resultado de ${applicationId}:`, error);
  }
}

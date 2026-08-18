/**
 * Fase 2A: aplicación de renta post-showing.
 *
 * Sigue el mismo patrón de token público que PropertyShortlist: el token
 * en claro solo existe en el link que recibe el prospecto; en la base solo
 * vive su hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';
import { isAllowedIdDocumentMimeType } from '@property-manager/core';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { getReplyAddressFromConversation, sendWithRetry } from './chatbot.service.js';
import {
  buildDocumentStorageKey,
  createLocalDocumentStorage,
  decodeBase64Payload,
  resolveStorageKeyWithinRoot,
} from './document-storage.service.js';
import { notifyStaffTargets, resolveStaffNotifyTargets } from './staff-notify.service.js';
import { triggerScreeningIfConsented } from './screening.service.js';

const DAY = 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 14 * DAY;

export function hashApplicationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createRentalApplication(input: {
  tenantId: string;
  showingId: string;
  leadId: string;
  unitId?: string | null;
}) {
  const token = randomBytes(24).toString('base64url');
  const application = await prisma.rentalApplication.create({
    data: {
      tenantId: input.tenantId,
      showingId: input.showingId,
      leadId: input.leadId,
      unitId: input.unitId ?? null,
      tokenHash: hashApplicationToken(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
  return { application, token };
}

export async function getPublicRentalApplication(token: string) {
  return prisma.rentalApplication.findFirst({
    where: { tokenHash: hashApplicationToken(token), expiresAt: { gt: new Date() } },
    include: {
      showing: { select: { id: true, scheduledAt: true } },
      unit: { select: { name: true, property: { select: { name: true, address: true, city: true, province: true } } } },
      tenant: { select: { name: true } },
    },
  });
}

export type CompleteShowingResult =
  | { ok: false; status: 404 | 409; error: string }
  | { ok: true; applicationId: string; linkDelivered: boolean; applicationUrl: string };

function canCompleteShowingStatus(status: string): boolean {
  return status === 'scheduled' || status === 'confirmed';
}

/**
 * Devuelve un resultado discriminado en vez de lanzar: el error handler
 * global de app.ts convierte cualquier throw en 500, y aquí necesitamos
 * distinguir 404 de 409.
 */
export async function completeShowingAndInvite(
  input: { showingId: string; tenantId: string; actorUserId: string | null },
  deps: { messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<CompleteShowingResult> {
  const showing = await prisma.showing.findFirst({
    where: { id: input.showingId, tenantId: input.tenantId },
    include: {
      lead: {
        include: {
          conversations: { orderBy: { updatedAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!showing) return { ok: false, status: 404, error: 'Showing not found' };
  if (!canCompleteShowingStatus(showing.status)) {
    return { ok: false, status: 409, error: `Showing cannot be completed from status: ${showing.status}` };
  }

  // `findFirst` + chequeo de status arriba no son atómicos con este update:
  // dos requests concurrentes (dos pestañas, dos usuarios) pueden pasar
  // ambas el guard. El `updateMany` con el mismo guard de status es la red
  // de seguridad — solo una de las dos transiciones puede tener éxito,
  // porque la segunda ya no encuentra una fila en 'scheduled'/'confirmed'.
  // Sin esto, ambas llamadas seguirían a `createRentalApplication`, y como
  // `showingId` es `@unique` en `rental_applications`, la segunda reventaría
  // con P2002 → 500 al broker, con el showing ya completado.
  const { count } = await prisma.showing.updateMany({
    where: { id: showing.id, tenantId: input.tenantId, status: { in: ['scheduled', 'confirmed'] } },
    // `undefined` (no `null`) omite el campo del UPDATE cuando ni el
    // showing ni el actor tienen un brokerUserId — deja la columna como
    // estaba en vez de escribir `null` explícito.
    data: { status: 'completed', brokerUserId: showing.brokerUserId ?? input.actorUserId ?? undefined },
  });
  if (count === 0) {
    return { ok: false, status: 409, error: `Showing cannot be completed from status: ${showing.status}` };
  }

  const { application, token } = await createRentalApplication({
    tenantId: input.tenantId,
    showingId: showing.id,
    leadId: showing.leadId,
    unitId: showing.unitId,
  });

  const applicationUrl = `${getEnv().WEB_URL.replace(/\/+$/, '')}/apply/${token}`;
  const conversation = showing.lead.conversations[0];
  let linkDelivered = false;

  // El canal `web` no tiene push saliente (su adapter es un mock
  // permanente): intentar "enviar" ahí reportaría éxito sin que le llegue
  // nada al prospecto.
  if (conversation && conversation.channel !== 'web') {
    const messaging = deps.messaging[conversation.channel as ChatChannel];
    if (messaging) {
      try {
        await sendWithRetry(() => messaging.send({
          to: getReplyAddressFromConversation(conversation.externalId),
          body: `Thanks for visiting! Please complete your rental application here:\n${applicationUrl}`,
          channel: conversation.channel as ChatChannel,
        }));
        linkDelivered = true;
      } catch (error) {
        // El showing ya quedó completado y la aplicación creada: un fallo
        // de entrega se reporta para que el PM mande el link a mano, no
        // deshace el resto.
        console.error(`[RentalApplication] No se pudo entregar el link de ${application.id}:`, error);
      }
    }
  }

  return { ok: true, applicationId: application.id, linkDelivered, applicationUrl };
}

export interface SubmitApplicationInput {
  annualIncome?: number | null;
  employerName?: string | null;
  references?: string | null;
  applicantFullName: string;
  // Fase 2.2 (adapter real): FrontLobby pide nombre y apellido por
  // separado. applicantFullName se sigue aceptando (derivado en el
  // frontend o el propio caller) por si algún consumidor viejo todavía lo
  // manda, pero ya no se usa para nada — se deriva de first+last aquí.
  applicantFirstName: string;
  applicantLastName: string;
  // Requeridos (a diferencia de los campos financieros/laborales de arriba):
  // el screening de crédito/antecedentes (Task 4) no puede correr sin
  // identidad — fecha de nacimiento y dirección actual son insumo mínimo
  // para que el adapter de screening pueda hacer match del solicitante.
  dateOfBirth: string; // ISO date
  currentAddress: string;
  currentCity: string;
  currentProvince: string;
  currentPostalCode: string;
  currentAddressStartDate: string; // ISO date
  consentApplication: boolean;
  consentCreditCheck: boolean;
  consentPoliceCheck: boolean;
  idDocumentFilename?: string | null;
  idDocumentMimeType?: string | null;
  idDocumentBase64?: string | null;
}

export type SubmitApplicationResult =
  | { ok: false; status: 400 | 404 | 409; error: string }
  | { ok: true; applicationId: string };

// Mismo tope que `fileBase64` en routes/documents.ts (~1.1 MB de archivo
// real una vez decodificado el base64).
const MAX_ID_DOCUMENT_BASE64_LENGTH = 1_500_000;

/**
 * Tope de espera del disparo del screening dentro del request HTTP. Muy por
 * debajo del timeout por default de Node (300s) — ver el comentario largo en
 * `submitRentalApplication`.
 */
const SCREENING_TRIGGER_TIMEOUT_MS = 8_000;

/**
 * `Promise.race` contra un timeout, limpiando el temporizador al terminar
 * para no dejar un handle vivo. El timer va `unref`eado: si la carrera la
 * gana la operación, un temporizador pendiente nunca debe mantener despierto
 * al proceso (ni colgar el runner de tests).
 */
async function raceWithTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function submitRentalApplication(
  token: string,
  input: SubmitApplicationInput,
  deps: { messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<SubmitApplicationResult> {
  const application = await getPublicRentalApplication(token);
  if (!application) return { ok: false, status: 404, error: 'Application not found or expired' };
  if (application.status === 'submitted') {
    return { ok: false, status: 409, error: 'Application already submitted' };
  }

  const missingConsents = [
    ...(input.consentApplication ? [] : ['consentApplication']),
    ...(input.consentCreditCheck ? [] : ['consentCreditCheck']),
    ...(input.consentPoliceCheck ? [] : ['consentPoliceCheck']),
  ];
  if (missingConsents.length > 0) {
    return { ok: false, status: 400, error: `Missing required consent: ${missingConsents.join(', ')}` };
  }
  if (!input.applicantFirstName.trim()) {
    return { ok: false, status: 400, error: 'applicantFirstName is required' };
  }
  if (!input.applicantLastName.trim()) {
    return { ok: false, status: 400, error: 'applicantLastName is required' };
  }
  // El endpoint público no tiene auth: alguien puede pegarle al POST
  // directo saltándose el `type="date"` del navegador. Sin validar que
  // parsea, un string tipo "garbage" pasa el `.trim()` y explota más abajo
  // en `new Date(...)` dentro del `updateMany` — Prisma revienta al
  // serializar un Invalid Date, y como la ruta solo hace `next(err)`, eso
  // se convierte en un 500 crudo en vez del 400 limpio que este bloque
  // busca dar para input público inválido.
  const parsedDateOfBirth = new Date(input.dateOfBirth);
  if (!input.dateOfBirth.trim() || Number.isNaN(parsedDateOfBirth.getTime())) {
    return { ok: false, status: 400, error: 'A valid dateOfBirth is required' };
  }
  // Mismo patrón que dateOfBirth arriba: input público sin auth, tiene que
  // parsear como fecha real antes de llegar a Prisma.
  const parsedAddressStartDate = new Date(input.currentAddressStartDate);
  if (!input.currentAddressStartDate.trim() || Number.isNaN(parsedAddressStartDate.getTime())) {
    return { ok: false, status: 400, error: 'A valid currentAddressStartDate is required' };
  }
  if (!input.currentAddress.trim() || !input.currentCity.trim() || !input.currentProvince.trim() || !input.currentPostalCode.trim()) {
    return { ok: false, status: 400, error: 'A complete current address is required' };
  }
  if (!input.idDocumentBase64 || !input.idDocumentFilename || !input.idDocumentMimeType) {
    return { ok: false, status: 400, error: 'A photo ID document is required' };
  }
  // Fix de revisión final (Critical 1 — XSS almacenado): `idDocumentMimeType`
  // lo manda el solicitante sin autenticar (ApplyPage.tsx toma `idFile.type`
  // del navegador tal cual) y se sirve crudo como `Content-Type` en la
  // descarga (getIdDocumentForDownload más abajo). Sin allowlist, un
  // solicitante puede mandar 'text/html' o 'image/svg+xml' con un cuerpo
  // malicioso; cuando el staff abre "Download ID document" ese script corre
  // en el origen del SPA — mismo origen que el refresh token httpOnly.
  // Allowlist estricta, no un chequeo truthy. Se aplica en los DOS lados:
  // aquí al recibir (rechaza con 400 antes de persistir) y de nuevo en
  // `getIdDocumentForDownload` al servir (no confía en que la fila ya esté
  // limpia — puede haber quedado un valor envenenado de antes de este fix).
  // La lista en sí vive en `@property-manager/core/id-document`, para que el
  // formulario público (ApplyPage.tsx) la consuma también y no vuelva a
  // desalinearse con esta validación.
  if (!isAllowedIdDocumentMimeType(input.idDocumentMimeType)) {
    return { ok: false, status: 400, error: 'Unsupported ID document file type' };
  }
  if (input.idDocumentBase64.length > MAX_ID_DOCUMENT_BASE64_LENGTH) {
    return { ok: false, status: 400, error: 'The ID document is too large' };
  }

  const env = getEnv();
  const storage = createLocalDocumentStorage({
    rootDir: path.resolve(env.DOCUMENT_STORAGE_DIR),
    publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined,
  });
  const stored = await storage.putObject({
    key: buildDocumentStorageKey({
      tenantId: application.tenantId,
      documentId: application.id,
      filename: input.idDocumentFilename,
    }),
    body: decodeBase64Payload(input.idDocumentBase64),
    contentType: input.idDocumentMimeType,
  });
  const idDocumentStorageKey = stored.storageKey;

  const now = new Date();
  // El chequeo de `status === 'submitted'` de arriba evita trabajo inútil en
  // el caso común, pero entre ese chequeo y aquí hubo un `await` que escribe
  // ~1MB a disco (`storage.putObject`): dos POSTs concurrentes del mismo
  // token pueden pasar ambos el chequeo temprano. Por eso el guard real de
  // la carrera es este `updateMany` con `status: 'invited'` en el `where`:
  // solo uno de los dos puede coincidir, y `count` nos dice cuál.
  const { count } = await prisma.rentalApplication.updateMany({
    where: { id: application.id, status: 'invited' },
    data: {
      status: 'submitted',
      submittedAt: now,
      annualIncome: input.annualIncome ?? null,
      employerName: input.employerName ?? null,
      references: input.references ?? null,
      applicantFirstName: input.applicantFirstName.trim(),
      applicantLastName: input.applicantLastName.trim(),
      applicantFullName: `${input.applicantFirstName.trim()} ${input.applicantLastName.trim()}`,
      dateOfBirth: parsedDateOfBirth,
      currentAddress: input.currentAddress.trim(),
      currentCity: input.currentCity.trim(),
      currentProvince: input.currentProvince.trim(),
      currentPostalCode: input.currentPostalCode.trim(),
      currentAddressStartDateAt: parsedAddressStartDate,
      idDocumentStorageKey,
      idDocumentMimeType: input.idDocumentMimeType,
      consentApplicationAt: now,
      consentCreditCheckAt: now,
      consentPoliceCheckAt: now,
    },
  });
  if (count === 0) {
    return { ok: false, status: 409, error: 'Application already submitted' };
  }

  await notifyStaffOfApplication(application.id, application.tenantId, deps);

  // Best-effort, igual que notifyStaffOfApplication arriba: la aplicación ya
  // quedó guardada (status 'submitted', ID document persistido) unas líneas
  // más arriba. Un throw aquí convertiría un submit exitoso en un 500 para
  // el prospecto, que además reintentaría y chocaría con el guard
  // `count === 0` de arriba (409, "ya enviada"), cuando en realidad sí se
  // envió.
  //
  // El try/catch solo cubre el throw. El caso peor es un HANG: `config/redis.ts`
  // configura ioredis con `maxRetriesPerRequest: null` (BullMQ lo exige) y sin
  // desactivar `enableOfflineQueue` (default `true`), así que con Redis caído
  // el `queue.add()` de adentro no resuelve NI rechaza — se queda en la cola
  // offline de ioredis. Un catch no atrapa un hang: el POST público
  // `/applications/:token` quedaría colgado hasta el timeout de Node (300s).
  // Por eso la carrera contra un timeout corto: si gana el timeout, se trata
  // igual que el catch (loguear y seguir). La operación de fondo se deja
  // correr — el request HTTP simplemente deja de esperarla.
  await raceWithTimeout(
    triggerScreeningIfConsented(application.id, application.tenantId),
    SCREENING_TRIGGER_TIMEOUT_MS,
  ).catch((error: unknown) => {
    console.error(`[RentalApplication] No se pudo disparar el screening de ${application.id}:`, error);
  });

  return { ok: true, applicationId: application.id };
}

export type GetIdDocumentResult =
  | { ok: false; status: 400 | 404; error: string }
  | { ok: true; file: Buffer; contentType: string };

/**
 * Fase 3: descarga del documento de identificación subido en el formulario
 * público (Fase 2A) — existía el archivo guardado pero nunca una ruta que lo
 * sirviera. Extraída de la ruta (en vez de vivir inline en el handler) para
 * poder testearla directo, igual que el resto de funciones de este archivo —
 * este repo no tiene infraestructura de supertest (ver leads.test.ts).
 */
export async function getIdDocumentForDownload(
  applicationId: string,
  tenantId: string,
): Promise<GetIdDocumentResult> {
  // Aislamiento por tenant: la fila se busca filtrada por el tenantId del
  // usuario autenticado ANTES de tocar el disco — mismo razonamiento que la
  // ruta de reportes de screening en leads.ts.
  const application = await prisma.rentalApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { idDocumentStorageKey: true, idDocumentMimeType: true },
  });
  if (!application) {
    return { ok: false, status: 404, error: 'Application not found' };
  }
  if (!application.idDocumentStorageKey) {
    return { ok: false, status: 404, error: 'ID document not available' };
  }

  const env = getEnv();
  const target = resolveStorageKeyWithinRoot(env.DOCUMENT_STORAGE_DIR, application.idDocumentStorageKey);
  if (target === null) {
    return { ok: false, status: 400, error: 'Invalid document path' };
  }
  const file = await fs.readFile(target);
  // Critical 1 (revisión final): no confiar en que la fila ya esté limpia —
  // filas escritas antes de este fix pueden tener un valor no confiable
  // persistido. Se re-valida contra la MISMA allowlist que usa el lado de
  // recepción arriba; cualquier valor fuera de ella (incluye null legacy)
  // cae al fallback seguro, igual que ya hacía el caso null.
  const contentType = isAllowedIdDocumentMimeType(application.idDocumentMimeType)
    ? application.idDocumentMimeType
    : 'application/octet-stream';
  return { ok: true, file, contentType };
}

/**
 * Best-effort: la aplicación del prospecto ya quedó guardada, así que un
 * fallo de notificación se loguea y nunca se propaga — si lo hiciera, el
 * prospecto vería un error y reintentaría, duplicando el envío.
 */
async function notifyStaffOfApplication(
  applicationId: string,
  tenantId: string,
  deps: { messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<void> {
  try {
    const application = await prisma.rentalApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: { showing: { select: { brokerUserId: true } }, lead: { select: { assignedUserId: true } } },
    });
    const staff = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, email: true, role: true, notificationChannel: true, notificationAddress: true },
    });
    const targets = resolveStaffNotifyTargets({
      brokerUserId: application.showing.brokerUserId,
      assignedUserId: application.lead.assignedUserId,
      staff: staff.map((member) => ({
        id: member.id,
        email: member.email,
        notificationChannel: member.notificationChannel,
        notificationAddress: member.notificationAddress,
      })),
      propertyManagerIds: staff.filter((member) => member.role === 'property_manager').map((member) => member.id),
    });

    await notifyStaffTargets({
      targets,
      subject: 'New rental application',
      body: `New rental application received from ${application.applicantFullName ?? 'a prospect'}.`,
      messaging: deps.messaging,
    });
  } catch (error) {
    console.error(`[RentalApplication] No se pudo notificar la aplicación ${applicationId}:`, error);
  }
}

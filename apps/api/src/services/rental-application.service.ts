/**
 * Fase 2A: aplicación de renta post-showing.
 *
 * Sigue el mismo patrón de token público que PropertyShortlist: el token
 * en claro solo existe en el link que recibe el prospecto; en la base solo
 * vive su hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { getReplyAddressFromConversation, sendWithRetry } from './chatbot.service.js';
import {
  buildDocumentStorageKey,
  createLocalDocumentStorage,
  decodeBase64Payload,
} from './document-storage.service.js';

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

export interface NotifiableStaff {
  id: string;
  email: string;
  notificationChannel: string | null;
  notificationAddress: string | null;
}

/**
 * A quién avisarle que llegó una aplicación, en orden de cercanía al
 * showing: el broker que lo atendió, si no el dueño del lead, y si no
 * todos los property managers del tenant. Un id que ya no corresponde a
 * ningún usuario (staff dado de baja) cae al siguiente nivel en vez de
 * dejar la notificación sin destinatario.
 */
export function resolveApplicationNotifyTargets(input: {
  brokerUserId: string | null;
  assignedUserId: string | null;
  staff: NotifiableStaff[];
  propertyManagerIds: string[];
}): NotifiableStaff[] {
  const byId = new Map(input.staff.map((member) => [member.id, member]));

  const broker = input.brokerUserId ? byId.get(input.brokerUserId) : undefined;
  if (broker) return [broker];

  const assignee = input.assignedUserId ? byId.get(input.assignedUserId) : undefined;
  if (assignee) return [assignee];

  return input.propertyManagerIds
    .map((id) => byId.get(id))
    .filter((member): member is NotifiableStaff => member !== undefined);
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
  input: { showingId: string; tenantId: string; actorUserId: string },
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

  await prisma.showing.update({
    where: { id: showing.id },
    data: { status: 'completed', brokerUserId: showing.brokerUserId ?? input.actorUserId },
  });

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
  if (!input.applicantFullName.trim()) {
    return { ok: false, status: 400, error: 'applicantFullName is required' };
  }
  if (!input.idDocumentBase64 || !input.idDocumentFilename || !input.idDocumentMimeType) {
    return { ok: false, status: 400, error: 'A photo ID document is required' };
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
  await prisma.rentalApplication.update({
    where: { id: application.id },
    data: {
      status: 'submitted',
      submittedAt: now,
      annualIncome: input.annualIncome ?? null,
      employerName: input.employerName ?? null,
      references: input.references ?? null,
      applicantFullName: input.applicantFullName.trim(),
      idDocumentStorageKey,
      consentApplicationAt: now,
      consentCreditCheckAt: now,
      consentPoliceCheckAt: now,
    },
  });

  await notifyStaffOfApplication(application.id, application.tenantId, deps);

  return { ok: true, applicationId: application.id };
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
    const targets = resolveApplicationNotifyTargets({
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

    const body = `New rental application received from ${application.applicantFullName ?? 'a prospect'}.`;

    for (const target of targets) {
      // Email y chat son independientes: que falle uno no debe impedir el otro.
      try {
        await deps.messaging.email.send({
          to: target.email,
          body,
          channel: 'email',
          subject: 'New rental application',
        });
      } catch (error) {
        console.error(`[RentalApplication] Email a ${target.id} falló:`, error);
      }

      if (target.notificationChannel && target.notificationAddress) {
        try {
          const channel = target.notificationChannel as ChatChannel;
          await deps.messaging[channel].send({ to: target.notificationAddress, body, channel });
        } catch (error) {
          console.error(`[RentalApplication] Chat a ${target.id} falló:`, error);
        }
      }
    }
  } catch (error) {
    console.error(`[RentalApplication] No se pudo notificar la aplicación ${applicationId}:`, error);
  }
}

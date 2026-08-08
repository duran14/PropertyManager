/**
 * Fase 2A: aplicación de renta post-showing.
 *
 * Sigue el mismo patrón de token público que PropertyShortlist: el token
 * en claro solo existe en el link que recibe el prospecto; en la base solo
 * vive su hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { getReplyAddressFromConversation, sendWithRetry } from './chatbot.service.js';

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

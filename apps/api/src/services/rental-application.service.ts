/**
 * Fase 2A: aplicación de renta post-showing.
 *
 * Sigue el mismo patrón de token público que PropertyShortlist: el token
 * en claro solo existe en el link que recibe el prospecto; en la base solo
 * vive su hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../config/db.js';

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

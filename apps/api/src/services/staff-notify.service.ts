/**
 * Notificación al staff, compartida entre cualquier flujo que necesite
 * avisarle a un humano (aplicaciones de renta recibidas, handoff del bot,
 * lo que siga). Resolución de destinatario y envío multi-canal, movidos
 * tal cual desde rental-application.service.ts (Fase 2A) para no
 * duplicarlos cuando Fase 1.2 necesitó el mismo patrón.
 */
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';

export interface NotifiableStaff {
  id: string;
  email: string;
  notificationChannel: string | null;
  notificationAddress: string | null;
}

/**
 * A quién avisarle, en orden de cercanía: el broker de la visita si lo
 * hay, si no el dueño del lead, y si no todos los property managers del
 * tenant. Un id que ya no corresponde a ningún usuario (staff dado de
 * baja) cae al siguiente nivel en vez de dejar la notificación sin
 * destinatario.
 */
export function resolveStaffNotifyTargets(input: {
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

/**
 * Email siempre, más el canal preferido si existe y no es 'web' (mock
 * permanente que reporta éxito sin entregar nada) ni 'email' (ya se
 * mandó arriba, duplicaría el correo). Cada envío es independiente: que
 * falle uno no debe impedir el otro ni propagar al llamador.
 */
export async function notifyStaffTargets(input: {
  targets: NotifiableStaff[];
  subject: string;
  body: string;
  messaging: Record<ChatChannel, MessagingAdapter>;
}): Promise<void> {
  for (const target of input.targets) {
    try {
      await input.messaging.email.send({
        to: target.email,
        body: input.body,
        channel: 'email',
        subject: input.subject,
      });
    } catch (error) {
      console.error(`[StaffNotify] Email a ${target.id} falló:`, error);
    }

    if (
      target.notificationChannel &&
      target.notificationAddress &&
      target.notificationChannel !== 'web' &&
      target.notificationChannel !== 'email'
    ) {
      try {
        const channel = target.notificationChannel as ChatChannel;
        await input.messaging[channel].send({ to: target.notificationAddress, body: input.body, channel });
      } catch (error) {
        console.error(`[StaffNotify] Chat a ${target.id} falló:`, error);
      }
    }
  }
}

/**
 * Fase 1B: reactivación de leads inactivos.
 *
 * Reutiliza la memoria de conversación ya guardada (ConversationSlot) y los
 * MessagingAdapter existentes por canal — sin infraestructura nueva más
 * allá de un job de BullMQ y dos campos nuevos en Lead.
 */
import type { ChatChannel } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { withTenant } from '../config/tenant-context.js';

export interface ReengagementCandidate {
  leadId: string;
  conversationId: string;
  channel: ChatChannel;
  externalId: string;
}

const INACTIVITY_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Un lead candidato: status temprano del funnel, sin showing agendado,
 * nunca remarketeado, no optó por no ser contactado, y su conversación
 * más reciente no tiene mensajes en los últimos 14 días. No hay un campo
 * denormalizado de "último mensaje", así que se calcula por lead.
 */
export async function findReengagementCandidates(tenantId: string): Promise<ReengagementCandidate[]> {
  return withTenant(prisma, tenantId, async (tx) => {
    const threshold = new Date(Date.now() - INACTIVITY_THRESHOLD_MS);
    const leads = await tx.lead.findMany({
      where: {
        tenantId,
        status: { in: ['new_', 'contacted', 'qualified'] },
        showings: { none: {} },
        lastRemarketedAt: null,
        optedOutAt: null,
      },
      include: {
        conversations: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          include: {
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });

    const candidates: ReengagementCandidate[] = [];
    for (const lead of leads) {
      const conversation = lead.conversations[0];
      const lastMessage = conversation?.messages[0];
      if (!conversation || !lastMessage) continue;
      if (lastMessage.createdAt >= threshold) continue;
      candidates.push({
        leadId: lead.id,
        conversationId: conversation.id,
        channel: conversation.channel as ChatChannel,
        externalId: conversation.externalId,
      });
    }
    return candidates;
  });
}

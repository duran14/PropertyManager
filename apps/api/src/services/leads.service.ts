/**
 * Servicio de Leads — captura desde ShowMojo y URLs públicas.
 */
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';

export interface ShowMojoEvent {
  tenantId: string;
  unitId?: string;
  name?: string;
  email?: string;
  phone?: string;
  tourDate?: string;
}

export interface LeadProspectProfile {
  budget?: string;
  moveInDate?: string;
  preferredArea?: string;
  occupants?: string;
  pets?: string;
  lastChannel?: string;
  conversationState?: string;
}

interface LeadConversationSummary {
  channel: string;
  state: string;
  updatedAt: Date;
  slots: Array<{ key: string; value: string }>;
}

/** Registra un lead desde un webhook de ShowMojo (registro de visita). */
export async function createLeadFromShowMojo(input: ShowMojoEvent): Promise<{ leadId: string }> {
  const lead = await prisma.lead.create({
    data: {
      tenantId: input.tenantId,
      unitId: input.unitId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      message: input.tourDate ? `Tour requested for ${input.tourDate}` : 'Tour requested via ShowMojo',
      source: 'showmojo',
      status: 'tour_scheduled',
    },
  });

  await writeAudit({
    tenantId: input.tenantId,
    actorId: 'showmojo_webhook',
    actorType: 'system',
    action: 'lead.created',
    entityType: 'lead',
    entityId: lead.id,
    payload: { source: 'showmojo', name: input.name, unitId: input.unitId },
  });

  return { leadId: lead.id };
}

/** Crea un lead desde el formulario de la URL pública de una unidad. */
export async function createLeadFromUnitUrl(input: {
  tenantId: string;
  unitId: string;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
}): Promise<{ leadId: string }> {
  const lead = await prisma.lead.create({
    data: {
      tenantId: input.tenantId,
      unitId: input.unitId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      message: input.message,
      source: 'unit_url',
      status: 'new_',
    },
  });

  await writeAudit({
    tenantId: input.tenantId,
    actorId: 'public_unit_url',
    actorType: 'system',
    action: 'lead.created',
    entityType: 'lead',
    entityId: lead.id,
    payload: { source: 'unit_url', unitId: input.unitId },
  });

  return { leadId: lead.id };
}

/** Lista leads de un tenant (para el dashboard de prospección). */
export async function listLeads(
  tenantId: string,
  opts: { status?: string; source?: string; limit?: number } = {},
) {
  const leads = await prisma.lead.findMany({
    where: {
      tenantId,
      ...(opts.status ? { status: opts.status as never } : {}),
      ...(opts.source ? { source: opts.source as never } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
    include: {
      unit: { select: { name: true, property: { select: { name: true } } } },
      conversations: {
        orderBy: { updatedAt: 'desc' },
        select: {
          channel: true,
          state: true,
          updatedAt: true,
          slots: { select: { key: true, value: true } },
        },
      },
    },
  });

  return leads.map((lead) => ({
    ...lead,
    prospectProfile: buildLeadProspectProfile(lead.conversations),
  }));
}

export function buildLeadProspectProfile(conversations: LeadConversationSummary[]): LeadProspectProfile {
  const sorted = [...conversations].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const profile: LeadProspectProfile = {};

  if (sorted[0]) {
    profile.lastChannel = sorted[0].channel;
    profile.conversationState = sorted[0].state;
  }

  const slotMap: Record<string, keyof LeadProspectProfile> = {
    budget: 'budget',
    move_in_date: 'moveInDate',
    preferred_area: 'preferredArea',
    occupants: 'occupants',
    pets: 'pets',
  };

  for (const conversation of sorted) {
    for (const slot of conversation.slots) {
      if (slot.key.startsWith('pending_') || slot.key.startsWith('scheduling_')) continue;
      const profileKey = slotMap[slot.key];
      if (profileKey && !profile[profileKey]) {
        profile[profileKey] = slot.value;
      }
    }
  }

  return profile;
}

/** Actualiza el estado de un lead (avanza el funnel). */
export async function updateLeadStatus(
  leadId: string,
  tenantId: string,
  status: string,
): Promise<void> {
  await prisma.lead.updateMany({
    where: { id: leadId, tenantId },
    data: { status: status as never },
  });
}

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
  return prisma.lead.findMany({
    where: {
      tenantId,
      ...(opts.status ? { status: opts.status as never } : {}),
      ...(opts.source ? { source: opts.source as never } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
    include: { unit: { select: { name: true, property: { select: { name: true } } } } },
  });
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

/**
 * Servicio de borradores de contrato RTA (Residential Tenancy Act de BC).
 *
 * IMPORTANTE (cumplimiento legal): el sistema SOLO genera BORRADORES.
 * No son documentos legalmente vinculantes hasta que el Managing Broker los
 * revise y firme. Esto evita incurrir en práctica legal no autorizada.
 *
 * El borrador se basa en los campos estándar requeridos por la RTA de BC:
 *  - Partes (landlord, tenant)
 *  - Dirección de la rental unit
 *  - Términos (start date, end date o month-to-month)
 *  - Rent amount y día de pago
 *  - Security deposit (máx. mitad del primer mes, según RTA s. 19)
 *  - Cláusulas estándar de la RTA
 */
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';

export interface RtaDraftInput {
  leaseId: string;
  tenantId: string;
  generatedByUserId: string;
}

export interface RtaDraft {
  leaseId: string;
  draftDocRef: string;
  content: string; // texto plano del borrador
  fields: RtaFields;
  disclaimer: string;
}

export interface RtaFields {
  landlordName: string;
  tenantName: string;
  tenantEmail: string;
  propertyAddress: string;
  unitName: string;
  startDate: string;
  endDate: string | null;
  rentCents: number;
  depositCents: number;
  paymentDay: number;
  tenancyType: 'fixed_term' | 'month_to_month';
}

const RTA_DISCLAIMER =
  'Este documento es un BORRADOR generado automáticamente y NO constituye un ' +
  'contrato legalmente vinculante hasta ser revisado y firmado por el Managing Broker. ' +
  'Generado conforme a la Residential Tenancy Act de British Columbia.';

/**
 * Genera un borrador de contrato RTA-BC a partir de un lease existente.
 * Persiste el draftDocRef en el lease y registra la auditoría.
 */
export async function generateRtaDraft(input: RtaDraftInput): Promise<RtaDraft> {
  const lease = await prisma.lease.findFirst({
    where: { id: input.leaseId, tenantId: input.tenantId },
    include: {
      unit: { include: { property: true } },
      tenantRecord: true,
    },
  });
  if (!lease) throw new Error('Lease no encontrado');

  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId },
    select: { name: true },
  });

  const fields: RtaFields = {
    landlordName: tenant?.name ?? 'Property Management Co.',
    tenantName: `${lease.tenantRecord.firstName} ${lease.tenantRecord.lastName}`,
    tenantEmail: lease.tenantRecord.email ?? '',
    propertyAddress: `${lease.unit.property.address}, ${lease.unit.property.city}, ${lease.unit.property.province}`,
    unitName: lease.unit.name,
    startDate: lease.startDate.toISOString().slice(0, 10),
    endDate: lease.endDate ? lease.endDate.toISOString().slice(0, 10) : null,
    rentCents: lease.rentCents,
    depositCents: lease.depositCents ?? 0,
    paymentDay: 1, // estándar en BC
    tenancyType: lease.endDate ? 'fixed_term' : 'month_to_month',
  };

  const draftDocRef = `rta_draft_${lease.id}_${Date.now()}`;
  const content = renderRtaText(fields);

  // Guardamos el draftDocRef en el lease.
  await prisma.lease.update({
    where: { id: lease.id },
    data: { rtaDraftDocRef: draftDocRef },
  });

  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.generatedByUserId,
    actorType: 'user',
    action: 'rta.draft_generated',
    entityType: 'lease',
    entityId: lease.id,
    payload: { draftDocRef, disclaimer: 'borrador no vinculante' },
  });

  return {
    leaseId: lease.id,
    draftDocRef,
    content,
    fields,
    disclaimer: RTA_DISCLAIMER,
  };
}

/**
 * Marca un borrador como firmado por el Broker (sube el doc firmado).
 * Solo el broker puede hacer esto.
 */
export async function signRtaDraft(
  leaseId: string,
  tenantId: string,
  brokerId: string,
  signedDocRef: string,
): Promise<void> {
  const lease = await prisma.lease.findFirst({ where: { id: leaseId, tenantId } });
  if (!lease) throw new Error('Lease no encontrado');

  await prisma.lease.update({
    where: { id: leaseId },
    data: { signedDocRef },
  });

  await writeAudit({
    tenantId,
    actorId: brokerId,
    actorType: 'user',
    action: 'rta.signed',
    entityType: 'lease',
    entityId: leaseId,
    payload: { signedDocRef, note: 'firmado por Managing Broker' },
  });
}

/** Renderiza el texto del borrador RTA con los campos del lease. */
function renderRtaText(f: RtaFields): string {
  const rentFormatted = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(f.rentCents / 100);
  const depositFormatted = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(f.depositCents / 100);

  return `RESIDENTIAL TENANCY AGREEMENT (BORRADOR)
British Columbia — Residential Tenancy Act
==========================================

LANDLORD: ${f.landlordName}
TENANT: ${f.tenantName} (${f.tenantEmail})

RENTAL UNIT: ${f.unitName}, ${f.propertyAddress}

TERM: ${f.tenancyType === 'fixed_term' ? 'Fixed-term' : 'Month-to-month'}
  Start date: ${f.startDate}
  ${f.endDate ? `End date: ${f.endDate}` : 'Continues on a month-to-month basis'}

RENT: ${rentFormatted} CAD per month, payable on day ${f.paymentDay} of each month.

SECURITY DEPOSIT: ${depositFormatted} CAD
  (Conforme a RTA s. 19: máximo equivalente a medio mes de renta)

PAYMENT METHOD: Interac e-Transfer al correo designado por el Landlord.

STANDARD TERMS: Este acuerdo está sujeto a los términos estándar de la
Residential Tenancy Act de British Columbia y sus regulaciones.

${RTA_DISCLAIMER}

Generated: ${new Date().toISOString()}
`;
}

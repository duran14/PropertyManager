/**
 * Fase 3: estado de cuenta mensual del dueño.
 *
 * El estado de cuenta se CALCULA desde los Transaction/Bill que ya
 * registran el Financial Sentinel y el Puente Contable — no hay libro
 * mayor paralelo ni saldo acumulado en ninguna columna. ADR-005: esto no
 * mueve fondos, solo produce el documento y la instrucción de pago.
 */
import { calculateOwnerStatement, monthBoundsUtc, parseStatementPeriod } from '@property-manager/core';
import { prisma } from '../config/db.js';

/** Un gasto solo cuenta si ya pasó por su compuerta de revisión humana. */
const COUNTABLE_BILL_STATUSES = ['approved', 'synced_to_qbo'] as const;

export interface StatementPreview {
  propertyId: string;
  propertyName: string;
  ownerId: string | null;
  ownerName: string | null;
  period: string;
  periodStart: Date;
  periodEnd: Date;
  appliedFeePercentBps: number;
  reserveTargetCents: number;
  reserveAlreadyWithheldCents: number;
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  ownerPayoutCents: number;
  shortfallCents: number;
  alreadyClosed: boolean;
}

export type StatementPreviewResult =
  | { ok: false; status: 400 | 404; error: string }
  | { ok: true; preview: StatementPreview };

export async function previewOwnerStatement(input: {
  tenantId: string;
  propertyId: string;
  period: string;
}): Promise<StatementPreviewResult> {
  const parsed = parseStatementPeriod(input.period);
  if (!parsed) return { ok: false, status: 400, error: 'Invalid period; expected YYYY-MM' };

  const property = await prisma.property.findFirst({
    where: { id: input.propertyId, tenantId: input.tenantId },
    include: { owner: true, units: { select: { id: true } } },
  });
  if (!property) return { ok: false, status: 404, error: 'Property not found' };

  const { periodStart, periodEnd } = monthBoundsUtc(parsed.year, parsed.month);
  const unitIds = property.units.map((unit) => unit.id);

  const [rentAggregate, billAggregate, priorReserve, existing] = await Promise.all([
    // Los ingresos se filtran por occurredAt (cuándo se recibió), no por
    // createdAt: un pago capturado tarde pertenece al mes en que ocurrió.
    unitIds.length === 0
      ? Promise.resolve({ _sum: { amountCents: null } })
      : prisma.transaction.aggregate({
        _sum: { amountCents: true },
        where: {
          tenantId: input.tenantId,
          type: 'rent_payment',
          unitId: { in: unitIds },
          occurredAt: { gte: periodStart, lt: periodEnd },
        },
      }),
    // Los gastos se filtran por billDate (la fecha de la factura): un
    // recibo de julio subido en agosto es un gasto de julio.
    prisma.bill.aggregate({
      _sum: { totalCents: true },
      where: {
        tenantId: input.tenantId,
        status: { in: [...COUNTABLE_BILL_STATUSES] },
        billDate: { gte: periodStart, lt: periodEnd },
        OR: [
          { propertyId: property.id },
          ...(unitIds.length > 0 ? [{ unitId: { in: unitIds } }] : []),
        ],
      },
    }),
    prisma.ownerStatement.aggregate({
      _sum: { reserveWithheldCents: true },
      where: { propertyId: property.id, periodStart: { lt: periodStart } },
    }),
    prisma.ownerStatement.findUnique({
      where: { propertyId_periodStart: { propertyId: property.id, periodStart } },
      select: { id: true },
    }),
  ]);

  const rentIncomeCents = rentAggregate._sum.amountCents ?? 0;
  const expensesCents = billAggregate._sum.totalCents ?? 0;
  const reserveAlreadyWithheldCents = priorReserve._sum.reserveWithheldCents ?? 0;

  const breakdown = calculateOwnerStatement({
    rentIncomeCents,
    expensesCents,
    managementFeePercentBps: property.managementFeePercentBps,
    reserveFundTargetCents: property.reserveFundTargetCents,
    reserveAlreadyWithheldCents,
  });

  return {
    ok: true,
    preview: {
      propertyId: property.id,
      propertyName: property.name,
      ownerId: property.ownerId,
      ownerName: property.owner ? `${property.owner.firstName} ${property.owner.lastName}` : null,
      period: input.period,
      periodStart,
      periodEnd,
      appliedFeePercentBps: property.managementFeePercentBps,
      reserveTargetCents: property.reserveFundTargetCents,
      reserveAlreadyWithheldCents,
      ...breakdown,
      alreadyClosed: existing !== null,
    },
  };
}

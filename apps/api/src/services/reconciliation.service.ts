/**
 * Servicio de Reconciliación — aplica el motor de core a los datos reales.
 *
 * Ejecuta el matching diario entre los 3 sistemas (Buildium, Banco, QBO) y
 * persiste el resultado como ReconciliationBatch + Discrepancies.
 *
 * Regla de oro BC: Balance QBO === Balance Banco === Registro Buildium.
 */
import type { PlaidAdapter, QboAdapter } from '@property-manager/adapters';
import { reconcile, type LedgerEntry } from '@property-manager/core';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { buildAuditCreateInput } from './audit-helpers.js';

export interface ReconcileDeps {
  qbo: QboAdapter;
  plaid: PlaidAdapter;
  /** ID del item de Plaid (por ahora asumimos uno por tenant). */
  plaidItemId?: string;
}

export interface ReconcileResult {
  batchId: string;
  balanced: boolean;
  qboBalanceCents: number;
  bankBalanceCents: number;
  buildiumBalanceCents: number;
  reconciledCount: number;
  discrepancyCount: number;
}

/**
 * Ejecuta la reconciliación diaria para un tenant.
 *
 * 1. Carga todas las transacciones del día desde la BD (que provienen de
 *    Buildium/banco/QBO vía los adapters o webhooks).
 * 2. Las pasa por el motor de matching de core.
 * 3. Persiste el ReconciliationBatch + Discrepancies.
 * 4. Verifica el triple balance.
 */
export async function runReconciliation(
  tenantId: string,
  runDate: Date,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const startOfDay = new Date(runDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(runDate);
  endOfDay.setHours(23, 59, 59, 999);

  // 1. Carga transacciones del día (todas las fuentes ya ingeridas).
  const txs = await prisma.transaction.findMany({
    where: {
      tenantId,
      occurredAt: { gte: startOfDay, lte: endOfDay },
    },
  });

  const ledgerEntries: LedgerEntry[] = txs.map((t) => ({
    id: t.id,
    source: t.source,
    type: t.type,
    amountCents: t.amountCents,
    reference: t.reference,
    occurredAt: t.occurredAt.toISOString(),
    unitId: t.unitId ?? undefined,
  }));

  // 2. Matching.
  const matchResult = reconcile(ledgerEntries);

  // 3. Triple balance — consultamos QBO y Plaid (banco) para las cuentas clave.
  const dateStr = runDate.toISOString().slice(0, 10);
  const [qboTrust, qboOperating, bankAccounts] = await Promise.all([
    deps.qbo.getAccountBalance('Trust Account', dateStr).catch(() => null),
    deps.qbo.getAccountBalance('Operating Account', dateStr).catch(() => null),
    deps.plaid.getAccounts(deps.plaidItemId ?? 'item_demo').catch(() => []),
  ]);

  const qboBalanceCents = (qboTrust?.amount ?? 0) + (qboOperating?.amount ?? 0);
  const bankBalanceCents = bankAccounts.reduce((sum, a) => sum + a.currentBalanceCents, 0);

  // Buildium: sumamos las transacciones de fuente buildium como proxy del registro.
  const buildiumBalanceCents = txs
    .filter((t) => t.source === 'buildium')
    .reduce((sum, t) => sum + t.amountCents, 0);

  const balanced = qboBalanceCents === bankBalanceCents && bankBalanceCents === buildiumBalanceCents;

  // 4. Persistencia del batch + discrepancias.
  return prisma.$transaction(async (tx) => {
    const batch = await tx.reconciliationBatch.create({
      data: {
        tenantId,
        runDate,
        qboBalanceCents,
        bankBalanceCents,
        buildiumBalanceCents,
        balanced,
      },
    });

    // Marcamos las transacciones reconciliadas.
    const reconciledIds = new Set(matchResult.reconciled.flatMap((e) => e.entries.map((x) => x.id)));
    if (reconciledIds.size > 0) {
      await tx.transaction.updateMany({
        where: { id: { in: [...reconciledIds] }, tenantId },
        data: { reconciliationBatchId: batch.id },
      });
    }

    // Persistimos las discrepancias detectadas.
    if (matchResult.discrepancies.length > 0) {
      await tx.discrepancy.createMany({
        data: matchResult.discrepancies.map((d) => ({
          tenantId,
          reconciliationBatchId: batch.id,
          kind: d.kind,
          entryReference: d.entry.reference,
          entryAmountCents: d.entry.amountCents,
          relatedReferences: d.relatedEntries?.map((e) => e.reference) ?? [],
        })),
      });
    }

    await tx.auditEntry.create({
      data: await buildAuditCreateInput({
        tx,
        tenantId,
        actorId: 'system_reconciliation',
        actorType: 'system',
        action: 'reconciliation.run',
        entityType: 'reconciliation_batch',
        entityId: batch.id,
        payload: {
          runDate: dateStr,
          balanced,
          reconciledCount: matchResult.reconciled.length,
          discrepancyCount: matchResult.discrepancies.length,
          qboBalanceCents,
          bankBalanceCents,
          buildiumBalanceCents,
        },
      }),
    });

    return {
      batchId: batch.id,
      balanced,
      qboBalanceCents,
      bankBalanceCents,
      buildiumBalanceCents,
      reconciledCount: matchResult.reconciled.length,
      discrepancyCount: matchResult.discrepancies.length,
    };
  });
}

/** Lista las discrepancias pendientes de un tenant (para el dashboard). */
export async function listDiscrepancies(
  tenantId: string,
  opts: { resolved?: boolean; limit?: number } = {},
) {
  return prisma.discrepancy.findMany({
    where: {
      tenantId,
      ...(opts.resolved !== undefined ? { resolved: opts.resolved } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
    include: { reconciliationBatch: { select: { runDate: true } } },
  });
}

/** Resuelve una discrepancia (bookkeeper la marcó como atendida). */
export async function resolveDiscrepancy(
  discrepancyId: string,
  tenantId: string,
  resolvedByUserId: string,
): Promise<void> {
  await prisma.discrepancy.updateMany({
    where: { id: discrepancyId, tenantId },
    data: { resolved: true, resolvedByUserId, resolvedAt: new Date() },
  });
}

// Re-export del tipo para conveniencia.
export type { Prisma };

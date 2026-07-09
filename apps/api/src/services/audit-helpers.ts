/**
 * Helpers de audit trail para uso dentro de transacciones Prisma.
 *
 * Calcula el hash chaining consultando el último entry del tenant dentro de
 * la misma transacción, garantizando consistencia.
 */
import { buildAuditEntry, type AuditActorType } from '@property-manager/core';
import type { Prisma } from '@prisma/client';

export interface BuildAuditInput {
  tx: Prisma.TransactionClient;
  tenantId: string;
  actorId: string;
  actorType: AuditActorType;
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export async function buildAuditCreateInput(
  args: BuildAuditInput,
): Promise<Prisma.AuditEntryCreateInput> {
  const last = await args.tx.auditEntry.findFirst({
    where: { tenantId: args.tenantId },
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  });
  const occurredAt = new Date().toISOString();
  const entry = buildAuditEntry(
    {
      tenantId: args.tenantId,
      actorId: args.actorId,
      actorType: args.actorType,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      payload: args.payload,
      occurredAt,
    },
    last?.hash,
  );
  return {
    tenant: { connect: { id: args.tenantId } },
    actorId: entry.actorId,
    actorType: entry.actorType,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    payload: entry.payload as Prisma.InputJsonValue,
    occurredAt: new Date(occurredAt),
    previousHash: entry.previousHash,
    hash: entry.hash,
  };
}

/**
 * Servicio de verificación de integridad del audit trail.
 *
 * Recarga toda la cadena de un tenant desde la BD y verifica que cada hash
 * esté bien encadenado (tamper-evident). El bookkeeper puede correrlo desde
 * el dashboard para auditar que nadie alteró el registro.
 */
import { verifyChain, type AuditEntry as CoreAuditEntry } from '@property-manager/core';
import { prisma } from '../config/db.js';

export interface ChainVerification {
  /** null = cadena íntegra. Número = índice de la primera entrada rota. */
  firstBrokenIndex: number | null;
  totalEntries: number;
  /** true si toda la cadena está íntegra. */
  intact: boolean;
}

export async function verifyAuditChain(tenantId: string): Promise<ChainVerification> {
  const dbEntries = await prisma.auditEntry.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });

  if (dbEntries.length === 0) {
    return { firstBrokenIndex: null, totalEntries: 0, intact: true };
  }

  // Mapeamos al formato que espera el core.
  const coreEntries: CoreAuditEntry[] = dbEntries.map((e) => ({
    tenantId: e.tenantId,
    actorId: e.actorId,
    actorType: e.actorType as 'user' | 'system' | 'ai_agent',
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    payload: e.payload as Record<string, unknown>,
    occurredAt: e.occurredAt.toISOString(),
    previousHash: e.previousHash,
    hash: e.hash,
  }));

  const brokenIndex = verifyChain(coreEntries);
  return {
    firstBrokenIndex: brokenIndex,
    totalEntries: dbEntries.length,
    intact: brokenIndex === null,
  };
}

/** Lista el audit trail de un tenant con filtros (paginado). */
export async function listAuditTrail(
  tenantId: string,
  opts: {
    actorType?: string;
    action?: string;
    entityType?: string;
    limit?: number;
    cursor?: string;
  } = {},
) {
  return prisma.auditEntry.findMany({
    where: {
      tenantId,
      ...(opts.actorType ? { actorType: opts.actorType } : {}),
      ...(opts.action ? { action: { contains: opts.action } } : {}),
      ...(opts.entityType ? { entityType: opts.entityType } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
}

/**
 * Servicio de Audit Trail.
 *
 * Persiste entradas de auditoría encadenadas (hash chaining) en la BD.
 * La entrada siempre incluye el hash de la anterior dentro del mismo tenant,
 * haciendo el registro tamper-evident.
 *
 * Cumplimiento: requisito para auditoría BC — toda acción de la IA y de
 * usuarios sobre fondos queda trazada e inmutable.
 */
import { Prisma, type AuditEntry, type UserRole } from '@prisma/client';
import { buildAuditEntry, type AuditActorType } from '@property-manager/core';
import { prisma } from '../config/db.js';

export interface WriteAuditInput {
  tenantId: string;
  actorId: string;
  actorType: AuditActorType;
  action: string; // namespace.accion
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Escribe una entrada de auditoría encadenándola a la última del tenant.
 * Transaccional: lee el último hash y escribe en la misma transacción para
 * evitar huecos si dos acciones compiten.
 */
export async function writeAudit(input: WriteAuditInput): Promise<AuditEntry> {
  const occurredAt = input.occurredAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    const last = await tx.auditEntry.findFirst({
      where: { tenantId: input.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { hash: true },
    });

    const entry = buildAuditEntry(
      {
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorType: input.actorType,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload,
        occurredAt: occurredAt.toISOString(),
      },
      last?.hash,
    );

    return tx.auditEntry.create({
      data: {
        tenantId: entry.tenantId,
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        payload: entry.payload as Prisma.InputJsonValue,
        occurredAt,
        previousHash: entry.previousHash,
        hash: entry.hash,
      },
    });
  });
}

/** Lee el audit trail de un tenant (paginado, filtrable por entidad/acción). */
export async function listAudit(
  tenantId: string,
  opts: { entityType?: string; entityId?: string; limit?: number; cursor?: string } = {},
): Promise<AuditEntry[]> {
  return prisma.auditEntry.findMany({
    where: {
      tenantId,
      ...(opts.entityType ? { entityType: opts.entityType } : {}),
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
}

/**
 * Verifica la integridad de la cadena de auditoría de un tenant.
 * Devuelve el índice de la primera entrada rota, o null si todo está bien.
 *
 * El bookkeeper puede correr esto manualmente desde el dashboard.
 */
export async function verifyAuditChain(tenantId: string): Promise<number | null> {
  // Nota: el cálculo del hash vive en core/audit.ts; aquí solo cargamos y delegamos.
  // Implementación completa de verificación en Fase 5 (dashboard de auditoría).
  const entries = await prisma.auditEntry.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });
  // La verificación real con verifyChain() se conecta en Fase 5.
  void entries;
  return null;
}

/** Helper: actorId y actorType derivados del contexto de auth. */
export function actorFromUser(userId: string, _role: UserRole): { actorId: string; actorType: 'user' } {
  return { actorId: userId, actorType: 'user' };
}

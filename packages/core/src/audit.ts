/**
 * Audit Trail inmutable con hash chaining.
 *
 * Cada acción de la IA (o de un usuario) en el sistema genera una entrada.
 * Las entradas se encadenan: cada una incluye el hash de la anterior.
 *
 * Esto hace el registro tamper-evident: alterar una entrada antigua rompe
 * todos los hashes siguientes, requisito clave para auditoría en BC.
 *
 * NOTA: la persistencia real (append-only, sin UPDATE/DELETE) se hace en la BD.
 * Aquí solo está la lógica pura de construcción y verificación de la cadena.
 */
import { createHash } from 'node:crypto';
import type { Id, IsoDate } from './types.js';

/** Marca de la primera entrada de una cadena (no hay anterior). */
export const GENESIS_HASH = 'genesis';

export type AuditActorType = 'user' | 'system' | 'ai_agent';

export type AuditAction = string; // namespace.action, ej: 'reconciliation.match'

export interface AuditEntryInput {
  tenantId: Id;
  actorId: Id; // userId o agentId
  actorType: AuditActorType;
  action: AuditAction;
  entityType: string;
  entityId: Id;
  payload: Record<string, unknown>;
  occurredAt: IsoDate;
}

export interface AuditEntry extends AuditEntryInput {
  /** Hash de la entrada anterior en la cadena (o 'genesis' si es la primera). */
  previousHash: string;
  /** Hash SHA-256 de esta entrada (incluye previousHash → encadenamiento). */
  hash: string;
}

/**
 * Construye una entrada de auditoría calculando su hash y encadenándola
 * a la anterior. La entrada es determinista: mismas props → mismo hash.
 */
export function buildAuditEntry(
  input: AuditEntryInput,
  previousHash: string | undefined,
): AuditEntry {
  const prev = previousHash ?? GENESIS_HASH;
  const hash = computeHash({ ...input, previousHash: prev });
  return { ...input, previousHash: prev, hash };
}

/**
 * Verifica que una cadena de entradas sea íntegra (ninguna fue alterada).
 * Devuelve el índice de la primera entrada rota, o null si todo está bien.
 */
export function verifyChain(entries: AuditEntry[]): number | null {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.previousHash !== expectedPrev) {
      return i;
    }
    const recomputed = computeHash({
      tenantId: entry.tenantId,
      actorId: entry.actorId,
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payload: entry.payload,
      occurredAt: entry.occurredAt,
      previousHash: entry.previousHash,
    });
    if (recomputed !== entry.hash) {
      return i;
    }
    expectedPrev = entry.hash;
  }
  return null;
}

/**
 * Hash SHA-256 del contenido canónico de la entrada.
 *
 * CRÍTICO: el payload se serializa con claves ordenadas recursivamente
 * (canonicalStringify), porque Postgres JSONB NO preserva el orden de claves
 * al guardar. Sin esto, el hash recomputeado al verificar no coincidiría.
 */
function computeHash(data: {
  tenantId: Id;
  actorId: Id;
  actorType: AuditActorType;
  action: AuditAction;
  entityType: string;
  entityId: Id;
  payload: Record<string, unknown>;
  occurredAt: IsoDate;
  previousHash: string;
}): string {
  const canonical = JSON.stringify({
    tenantId: data.tenantId,
    actorId: data.actorId,
    actorType: data.actorType,
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId,
    payload: canonicalize(data.payload),
    occurredAt: data.occurredAt,
    previousHash: data.previousHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Serializa un valor de forma canónica: ordena las claves de todos los objetos
 * recursivamente (alfabéticamente). Así el hash es estable sin importar el
 * orden de inserción de las claves del payload, que Postgres JSONB reordena.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

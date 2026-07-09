/**
 * Reconciliación cross-system: Buildium ↔ Banco ↔ QBO.
 *
 * Modelo: el MISMO evento económico (ej. "Sarah pagó $2,000 de renta") debe
 * aparecer en varios sistemas con el MISMO monto. No es doble-entry (débito/crédito),
 * es corroboración: varios registros independientes del mismo evento.
 *
 * Algoritmo:
 *  1. Se agrupan entradas que comparten "firma de evento" (|monto| + unidad + fecha ± tolerancia).
 *  2. Un evento está "reconciliado" si está corroborado por >= 2 fuentes distintas.
 *  3. Una entrada sola (sin corroboración) genera una discrepancia que indica
 *     en qué sistema falta registrar el movimiento.
 *
 * Regla de oro BC: Balance QBO === Balance Bancario === Registro Buildium.
 */
import type { Id, IsoDate, TransactionSource, TransactionType } from './types.js';

/** Un movimiento aislado de cualquiera de los 3 sistemas. */
export interface LedgerEntry {
  id: Id;
  source: TransactionSource;
  type: TransactionType;
  /** Monto en centavos. positivo = entrada, negativo = salida (para el flujo). */
  amountCents: number;
  reference: string; // ID externo (Buildium lease id, QBO doc id, etc.)
  occurredAt: IsoDate;
  /** A qué unidad pertenece, si se conoce. */
  unitId?: Id;
}

/** Resultado de la reconciliación. */
export interface ReconcileResult {
  /** Eventos confirmados (corroborados por >= 2 fuentes). */
  reconciled: ReconciledEvent[];
  /** Movimientos sin corroboración → requieren atención humana. */
  discrepancies: Discrepancy[];
}

export interface ReconciledEvent {
  entries: LedgerEntry[];
  amountCents: number;
  unitId?: Id;
}

export type DiscrepancyKind =
  | 'missing_in_qbo'
  | 'missing_in_buildium'
  | 'missing_in_bank'
  | 'amount_mismatch';

export interface Discrepancy {
  kind: DiscrepancyKind;
  entry: LedgerEntry;
  /** Entradas del mismo evento que SÍ se registraron (para contexto del bookkeeper). */
  relatedEntries?: LedgerEntry[];
}

/** Tolerancia por defecto: las fechas se matchean si están dentro de N días. */
const DEFAULT_DATE_TOLERANCE_DAYS = 3;

export interface ReconcileOptions {
  dateToleranceDays?: number;
}

/**
 * Reconcilia un conjunto de movimientos agrupándolos por evento económico.
 */
export function reconcile(entries: LedgerEntry[], options: ReconcileOptions = {}): ReconcileResult {
  const tolerance = options.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS;
  const reconciled: ReconciledEvent[] = [];
  const discrepancies: Discrepancy[] = [];

  // Asignamos cada entrada a un grupo (evento). Un grupo se identifica por
  // |monto| + unidad + ventana temporal. Usamos un approach O(n²) simple:
  // para el volumen del MVP (miles de movimientos/día) es suficiente.
  const groups: LedgerEntry[][] = [];

  for (const entry of entries) {
    const groupIdx = findMatchingGroup(entry, groups, tolerance);
    if (groupIdx >= 0) {
      groups[groupIdx]!.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  for (const group of groups) {
    const sources = new Set(group.map((e) => e.source));

    if (sources.size >= 2) {
      // Evento corroborado por múltiples sistemas.
      reconciled.push({
        entries: group,
        amountCents: Math.abs(group[0]!.amountCents),
        unitId: group[0]!.unitId,
      });
    } else {
      // Sin corroboración: la entrada(s) del único sistema genera discrepancia.
      // Indicamos qué sistemas faltan para completar la trazabilidad.
      const missingKinds = missingSources(sources);
      const first = group[0]!;
      for (const kind of missingKinds) {
        discrepancies.push({
          kind,
          entry: first,
          relatedEntries: group.length > 1 ? group.slice(1) : undefined,
        });
      }
    }
  }

  return { reconciled, discrepancies };
}

/**
 * Determina si una entrada pertenece a un grupo existente.
 * Misma firma = |monto| igual + (misma unidad o ambas sin unidad) + fecha cercana.
 */
function findMatchingGroup(
  entry: LedgerEntry,
  groups: LedgerEntry[][],
  toleranceDays: number,
): number {
  const absAmount = Math.abs(entry.amountCents);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const representative = group[0]!;
    if (Math.abs(representative.amountCents) !== absAmount) continue;
    if (entry.unitId && representative.unitId && entry.unitId !== representative.unitId) continue;
    const daysDiff = Math.abs(daysBetween(entry.occurredAt, representative.occurredAt));
    if (daysDiff <= toleranceDays) return i;
  }
  return -1;
}

/**
 * Dado el set de fuentes presentes, devuelve qué sistemas faltan
 * (para reportar discrepancias específicas al bookkeeper).
 *
 * Heurística: si solo hay buildium, falta en qbo+bank (el cobro se registró
 * pero no se ve en la contabilidad ni el banco). Si solo hay bank, falta en
 * qbo+buildium (entró dinero sin registrarse). Etc.
 */
function missingSources(present: Set<TransactionSource>): DiscrepancyKind[] {
  const all: TransactionSource[] = ['buildium', 'bank', 'qbo'];
  const missing: DiscrepancyKind[] = [];
  if (!present.has('qbo')) missing.push('missing_in_qbo');
  if (!present.has('buildium')) missing.push('missing_in_buildium');
  if (!present.has('bank')) missing.push('missing_in_bank');
  // 'manual' no cuenta como corroboración de sistema, se ignora aquí.
  void all;
  return missing;
}

/** Compara dos entradas del MISMO concepto con montos distintos. */
export function detectAmountMismatch(a: LedgerEntry, b: LedgerEntry): Discrepancy | null {
  if (a.reference === b.reference && a.amountCents !== b.amountCents) {
    return { kind: 'amount_mismatch', entry: a, relatedEntries: [b] };
  }
  return null;
}

function daysBetween(a: IsoDate, b: IsoDate): number {
  const ms = new Date(a).getTime() - new Date(b).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

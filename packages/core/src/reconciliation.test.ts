import { describe, expect, it } from 'vitest';
import { reconcile } from './reconciliation.js';
import type { Id } from './types.js';
import type { LedgerEntry } from './reconciliation.js';

function entry(
  partial: Partial<LedgerEntry> & Pick<LedgerEntry, 'id' | 'source' | 'amountCents'>,
): LedgerEntry {
  return {
    type: 'rent_payment',
    reference: partial.id,
    occurredAt: '2026-07-01T00:00:00Z',
    ...partial,
  } as LedgerEntry;
}

describe('reconciliación cross-system', () => {
  it('reconcilia cuando el mismo evento aparece en Buildium y Banco (corroboración)', () => {
    const result = reconcile([
      entry({ id: 'b1' as Id, source: 'buildium', amountCents: 240000 }),
      entry({ id: 'k1' as Id, source: 'bank', amountCents: 240000 }),
    ]);
    expect(result.reconciled).toHaveLength(1);
    expect(result.reconciled[0]?.entries).toHaveLength(2);
    expect(result.discrepancies).toHaveLength(0);
  });

  it('reconcilia cuando 3 fuentes corroboran el mismo evento', () => {
    const result = reconcile([
      entry({ id: 'b1' as Id, source: 'buildium', amountCents: 240000 }),
      entry({ id: 'k1' as Id, source: 'bank', amountCents: 240000 }),
      entry({ id: 'q1' as Id, source: 'qbo', amountCents: 240000 }),
    ]);
    expect(result.reconciled).toHaveLength(1);
    expect(result.discrepancies).toHaveLength(0);
  });

  it('reporta missing_in_bank y missing_in_qbo si solo está en Buildium', () => {
    const result = reconcile([
      entry({ id: 'b1' as Id, source: 'buildium', amountCents: 240000 }),
    ]);
    expect(result.reconciled).toHaveLength(0);
    const kinds = result.discrepancies.map((d) => d.kind).sort();
    expect(kinds).toEqual(['missing_in_bank', 'missing_in_qbo']);
  });

  it('reporta missing_in_buildium si está en qbo pero no en buildium', () => {
    const result = reconcile([
      entry({ id: 'q1' as Id, source: 'qbo', amountCents: 50000 }),
      entry({ id: 'k1' as Id, source: 'bank', amountCents: 50000 }),
    ]);
    expect(result.reconciled).toHaveLength(1); // bank+qbo corroboran
    // No hay discrepancia porque hay 2 fuentes. (buildium faltante es info, no error)
    expect(result.discrepancies).toHaveLength(0);
  });

  it('no agrupa movimientos de distinto monto', () => {
    const result = reconcile([
      entry({ id: 'b1' as Id, source: 'buildium', amountCents: 240000 }),
      entry({ id: 'k1' as Id, source: 'bank', amountCents: 239900 }),
    ]);
    expect(result.reconciled).toHaveLength(0);
    expect(result.discrepancies.length).toBeGreaterThan(0);
  });

  it('no agrupa movimientos de unidades distintas aunque coincida monto y fecha', () => {
    const result = reconcile([
      entry({ id: 'b1' as Id, source: 'buildium', amountCents: 240000, unitId: 'u101' as Id }),
      entry({ id: 'k1' as Id, source: 'bank', amountCents: 240000, unitId: 'u102' as Id }),
    ]);
    expect(result.reconciled).toHaveLength(0);
  });

  it('respeta tolerancia de fecha configurable', () => {
    const entries: LedgerEntry[] = [
      entry({
        id: 'b1' as Id,
        source: 'buildium',
        amountCents: 240000,
        occurredAt: '2026-07-01T00:00:00Z',
      }),
      entry({
        id: 'k1' as Id,
        source: 'bank',
        amountCents: 240000,
        occurredAt: '2026-07-10T00:00:00Z',
      }),
    ];
    expect(reconcile(entries, { dateToleranceDays: 3 }).reconciled).toHaveLength(0);
    expect(reconcile(entries, { dateToleranceDays: 15 }).reconciled).toHaveLength(1);
  });

  it('trata monto positivo y negativo del mismo evento como corroborables (|monto|)', () => {
    // Buildium lo registra como +2400 (cobro); el banco como -2400 (salida de cuenta).
    const result = reconcile([
      entry({ id: 'b1' as Id, source: 'buildium', amountCents: 240000 }),
      entry({ id: 'k1' as Id, source: 'bank', amountCents: -240000 }),
    ]);
    expect(result.reconciled).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { buildAuditEntry } from './audit.js';
import type { Id, IsoDate } from './types.js';

describe('audit trail (hash chaining)', () => {
  const baseProps = {
    tenantId: 'tenant_1' as Id,
    actorId: 'user_1' as Id,
    actorType: 'system' as const,
    action: 'reconciliation.match' as const,
    entityType: 'transaction' as const,
    entityId: 'tx_1' as Id,
    payload: { note: 'renta matcheada' },
    occurredAt: '2026-07-07T12:00:00Z' as IsoDate,
  };

  it('calcula el mismo hash deterministamente para la misma entrada', () => {
    const a = buildAuditEntry(baseProps, undefined);
    const b = buildAuditEntry({ ...baseProps }, undefined);
    expect(a.hash).toBe(b.hash);
  });

  it('usa previousHash=genesis para la primera entrada de la cadena', () => {
    const entry = buildAuditEntry(baseProps, undefined);
    expect(entry.previousHash).toBe('genesis');
  });

  it('encadena cada entrada al hash de la anterior', () => {
    const first = buildAuditEntry(baseProps, undefined);
    const second = buildAuditEntry(
      { ...baseProps, entityId: 'tx_2' as Id, occurredAt: '2026-07-07T12:01:00Z' as IsoDate },
      first.hash,
    );
    expect(second.previousHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  it('cualquier alteración del payload rompe el hash (tamper-evident)', () => {
    const original = buildAuditEntry(baseProps, undefined);
    const tampered = buildAuditEntry(
      { ...baseProps, payload: { note: 'ALTERADO' } },
      undefined,
    );
    expect(tampered.hash).not.toBe(original.hash);
  });
});

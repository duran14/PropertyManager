import { describe, expect, it } from 'vitest';
import { parseAnnualIncome } from './leads.js';

/**
 * Fix 3 (final review): `annualIncome` es `Int` en Prisma, pero la ruta
 * aceptaba cualquier `number` de JS. Un decimal, un valor > 2^31, o
 * `Infinity` (que `JSON.parse` produce de `1e999`, y para el que
 * `typeof Infinity === 'number'` sigue siendo cierto) hacían que Prisma
 * lanzara al escribir → 500 genérico, y para entonces el documento de
 * identificación ya se había escrito a disco. `parseAnnualIncome` corre en
 * la ruta antes de llamar al servicio, así que un valor inválido nunca
 * llega a `submitRentalApplication` ni a `storage.putObject`.
 */
describe('parseAnnualIncome', () => {
  it('accepts a valid whole number', () => {
    expect(parseAnnualIncome(82000)).toEqual({ ok: true, value: 82000 });
  });

  it('accepts zero', () => {
    expect(parseAnnualIncome(0)).toEqual({ ok: true, value: 0 });
  });

  it('treats an absent value as valid and optional', () => {
    expect(parseAnnualIncome(undefined)).toEqual({ ok: true, value: null });
  });

  it('treats an explicit null as valid and optional', () => {
    expect(parseAnnualIncome(null)).toEqual({ ok: true, value: null });
  });

  it('rejects a decimal value', () => {
    const result = parseAnnualIncome(82000.5);
    expect(result.ok).toBe(false);
  });

  it('rejects a value above the range cap', () => {
    const result = parseAnnualIncome(2_000_000_001);
    expect(result.ok).toBe(false);
  });

  it('rejects a negative value', () => {
    const result = parseAnnualIncome(-1);
    expect(result.ok).toBe(false);
  });

  it('rejects Infinity (what JSON.parse produces from 1e999, still typeof "number")', () => {
    const result = parseAnnualIncome(Infinity);
    expect(result.ok).toBe(false);
  });

  it('rejects a value greater than 2^31', () => {
    const result = parseAnnualIncome(2 ** 31 + 1000);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-number value', () => {
    const result = parseAnnualIncome('82000');
    expect(result.ok).toBe(false);
  });

  it('accepts the upper bound of the range', () => {
    expect(parseAnnualIncome(2_000_000_000)).toEqual({ ok: true, value: 2_000_000_000 });
  });
});

import { describe, expect, it } from 'vitest';
import { calculateOwnerStatement, type OwnerStatementInput } from './owner-statement.js';

function input(overrides: Partial<OwnerStatementInput> = {}): OwnerStatementInput {
  return {
    rentIncomeCents: 0,
    expensesCents: 0,
    managementFeePercentBps: 1250,
    reserveFundTargetCents: 0,
    reserveAlreadyWithheldCents: 0,
    ...overrides,
  };
}

describe('calculateOwnerStatement', () => {
  it('computes a straightforward month', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      expensesCents: 30_000,
    }));

    expect(result.managementFeeCents).toBe(25_000); // 12.5% de 2000.00
    expect(result.reserveWithheldCents).toBe(0);
    expect(result.ownerPayoutCents).toBe(145_000);
    expect(result.shortfallCents).toBe(0);
  });

  it('rounds a fee that lands on half a cent', () => {
    // 1000.05 × 12.5% = 125.00625 → 12500.625 centavos → 12501
    const result = calculateOwnerStatement(input({ rentIncomeCents: 100_005 }));
    expect(result.managementFeeCents).toBe(12_501);
  });

  it('withholds only up to the reserve target', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      reserveFundTargetCents: 50_000,
      reserveAlreadyWithheldCents: 0,
    }));

    expect(result.reserveWithheldCents).toBe(50_000);
  });

  it('withholds nothing once the reserve target is already met', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      reserveFundTargetCents: 50_000,
      reserveAlreadyWithheldCents: 50_000,
    }));

    expect(result.reserveWithheldCents).toBe(0);
    expect(result.ownerPayoutCents).toBe(175_000);
  });

  it('tops the reserve back up after it was partially spent', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      reserveFundTargetCents: 50_000,
      reserveAlreadyWithheldCents: 20_000,
    }));

    expect(result.reserveWithheldCents).toBe(30_000);
  });

  it('never withholds more reserve than is available', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 100_000,
      expensesCents: 80_000,
      reserveFundTargetCents: 500_000,
    }));

    // Disponible = 100000 - 80000 - 12500 = 7500
    expect(result.reserveWithheldCents).toBe(7_500);
    expect(result.ownerPayoutCents).toBe(0);
    expect(result.shortfallCents).toBe(0);
  });

  it('reports a shortfall instead of a negative payout', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 100_000,
      expensesCents: 150_000,
    }));

    expect(result.ownerPayoutCents).toBe(0);
    expect(result.shortfallCents).toBe(62_500); // 150000 - 100000 + 12500
    expect(result.reserveWithheldCents).toBe(0);
  });

  it('handles a month with no activity at all', () => {
    const result = calculateOwnerStatement(input());

    expect(result).toEqual({
      rentIncomeCents: 0,
      expensesCents: 0,
      managementFeeCents: 0,
      reserveWithheldCents: 0,
      ownerPayoutCents: 0,
      shortfallCents: 0,
    });
  });

  it('charges no fee when the property has a 0% management fee', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      managementFeePercentBps: 0,
    }));

    expect(result.managementFeeCents).toBe(0);
    expect(result.ownerPayoutCents).toBe(200_000);
  });

  it.each([
    [200_000, 30_000, 1250, 0, 0],
    [100_005, 33_333, 1250, 50_000, 10_000],
    [100_000, 150_000, 1250, 0, 0],
    [1, 0, 1250, 0, 0],
    [999_999, 1, 875, 100_000, 99_999],
    [0, 5_000, 1250, 20_000, 0],
    [123_457, 65_432, 1000, 33_333, 11_111],
  ])(
    'keeps the parts summing exactly for (%i, %i, %i, %i, %i)',
    (rentIncomeCents, expensesCents, managementFeePercentBps, reserveFundTargetCents, reserveAlreadyWithheldCents) => {
      const r = calculateOwnerStatement({
        rentIncomeCents,
        expensesCents,
        managementFeePercentBps,
        reserveFundTargetCents,
        reserveAlreadyWithheldCents,
      });

      // La invariante central: nada se pierde ni se inventa al redondear.
      expect(
        r.rentIncomeCents - r.expensesCents - r.managementFeeCents - r.reserveWithheldCents,
      ).toBe(r.ownerPayoutCents - r.shortfallCents);

      // Ambos lados del neto son no negativos y al menos uno es cero.
      expect(r.ownerPayoutCents).toBeGreaterThanOrEqual(0);
      expect(r.shortfallCents).toBeGreaterThanOrEqual(0);
      expect(Math.min(r.ownerPayoutCents, r.shortfallCents)).toBe(0);
      expect(r.reserveWithheldCents).toBeGreaterThanOrEqual(0);
    },
  );
});

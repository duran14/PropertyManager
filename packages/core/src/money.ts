/**
 * Operaciones con dinero usando enteros (centavos).
 *
 * NUNCA uses `number` con decimales para dinero: 0.1 + 0.2 !== 0.3 en JS.
 * Toda la lógica contable opera en centavos y solo se formatea en la UI.
 */
import type { Currency, Money } from './types.js';

/** Convierte un monto decimal (ej. 1234.56) a centavos enteros (123456). */
export function toCents(decimal: number): number {
  if (!Number.isFinite(decimal)) {
    throw new Error(`Monto inválido: ${decimal}`);
  }
  return Math.round(decimal * 100);
}

/** Convierte centavos enteros a monto decimal (para mostrar). */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Crea un objeto Money a partir de un decimal. */
export function money(decimal: number, currency: Currency = 'CAD'): Money {
  return { amount: toCents(decimal), currency };
}

/** Suma dos montos. Deben tener la misma divisa. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

/** Resta a - b. Deben tener la misma divisa. */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

/** Multiplica un Money por un factor escalar (ej. prorratear). */
export function multiply(m: Money, factor: number): Money {
  return { amount: Math.round(m.amount * factor), currency: m.currency };
}

/** Compara dos montos. Devuelve -1, 0 o 1. */
export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return Math.sign(a.amount - b.amount);
}

/** ¿Son iguales (mismo monto y divisa)? */
export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

/** Suma una lista de montos (todos misma divisa). Lista vacía → 0. */
export function sum(list: Money[]): Money {
  if (list.length === 0) {
    throw new Error('sum() requiere al menos un elemento para inferir la divisa');
  }
  const currency = list[0]!.currency;
  return list.reduce<Money>(
    (acc, m) => {
      assertSameCurrency(acc, m);
      return { amount: acc.amount + m.amount, currency };
    },
    { amount: 0, currency },
  );
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Divisas incompatibles: ${a.currency} vs ${b.currency}`);
  }
}

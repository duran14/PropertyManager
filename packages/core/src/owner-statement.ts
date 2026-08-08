/**
 * Cálculo del estado de cuenta mensual del dueño.
 *
 * Función pura: recibe los totales ya agregados y la configuración de la
 * propiedad, devuelve el desglose. No consulta nada — así se puede probar
 * al centavo sin base de datos.
 *
 * ADR-005: esto NO mueve dinero. Produce los montos de un documento; el
 * pago lo ejecuta un humano fuera del sistema.
 */

const BPS_DENOMINATOR = 10_000;

export interface OwnerStatementInput {
  rentIncomeCents: number;
  expensesCents: number;
  /** Comisión en basis points enteros (1250 = 12.5%). */
  managementFeePercentBps: number;
  reserveFundTargetCents: number;
  /** Suma de lo ya retenido en los estados de cuenta cerrados previos. */
  reserveAlreadyWithheldCents: number;
}

export interface OwnerStatementBreakdown {
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  /** No negativo. Cero cuando el mes cerró en rojo. */
  ownerPayoutCents: number;
  /** No negativo. Cero salvo que el mes cerrara en rojo. */
  shortfallCents: number;
}

export function calculateOwnerStatement(input: OwnerStatementInput): OwnerStatementBreakdown {
  const managementFeeCents = Math.round(
    (input.rentIncomeCents * input.managementFeePercentBps) / BPS_DENOMINATOR,
  );

  const available = input.rentIncomeCents - input.expensesCents - managementFeeCents;

  const reserveGap = Math.max(0, input.reserveFundTargetCents - input.reserveAlreadyWithheldCents);
  const reserveWithheldCents = Math.max(0, Math.min(reserveGap, available));

  // El neto se obtiene por RESTA, no por otro redondeo: así la suma de las
  // partes es exacta al centavo por construcción, que es justo el objetivo
  // de "liquidación exacta en $0.00".
  const net = available - reserveWithheldCents;

  return {
    rentIncomeCents: input.rentIncomeCents,
    expensesCents: input.expensesCents,
    managementFeeCents,
    reserveWithheldCents,
    // Se parte en dos campos no negativos: un monto negativo en el pago
    // sería un cobro al dueño, que es otra cosa y merece su propio campo.
    ownerPayoutCents: Math.max(0, net),
    shortfallCents: Math.max(0, -net),
  };
}

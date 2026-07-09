/**
 * Motor de confidence scoring — la pieza central del Human-in-the-Loop (HITL).
 *
 * El Financial Sentinel nunca actúa "ciego": cada acción contable potencial
 * pasa por aquí. El score determina si:
 *  - auto_approve: la IA puede actuar sola (marca pagado, crea Bill, etc.)
 *  - review: requiere aprobación humana del Bookkeeper
 *  - reject: el movimiento es sospechoso, no se procesa
 *
 * Pesos cuidadosamente elegidos para privilegiar la integridad financiera:
 * que el MONTO y el REMITENTE coincidan pesa más que la fecha.
 */
import type { ConfidenceDecision } from './types.js';

export interface ConfidenceInput {
  /** 0..1 — qué tan cerca está el monto del esperado (1 = exacto). */
  amountMatch: number;
  /** 0..1 — cercanía de la fecha (1 = mismo día). */
  dateProximity: number;
  /** ¿El remitente está verificado contra el inquilino/propietario esperado? */
  senderVerified: boolean;
  /** ¿Se extrajo correctamente el documento (recibo/factura) por OCR? */
  documentExtracted: boolean;
  /** ¿Este remitente ha pagado antes sin incidencias? */
  priorHistoryMatches: boolean;
  /** Peso extra opcional que el agente IA puede aportar (razonamiento GLM). 0..1. */
  customWeight: number;
}

export interface ConfidenceOptions {
  /** Umbral por encima del cual se auto-aprueba. Default 0.85. */
  threshold: number;
  /** Por debajo de este score se rechaza (no se manda a review). Default 0.3. */
  rejectFloor?: number;
}

export interface ConfidenceResult {
  score: number; // 0..1
  decision: ConfidenceDecision;
  /** Factores que bajaron la confianza (para el audit trail y la UI). */
  reasons: string[];
}

// Pesos de cada factor. Suman 1.0 para los factores principales.
const WEIGHTS = {
  amount: 0.35, // El monto es lo más importante en contabilidad.
  date: 0.15,
  sender: 0.2,
  document: 0.1,
  history: 0.15,
  custom: 0.05, // El agente IA aporta un toque final.
} as const;

export function decide(input: ConfidenceInput, options: ConfidenceOptions): ConfidenceResult {
  const { threshold, rejectFloor = 0.3 } = options;
  const reasons: string[] = [];

  // Cada factor aporta su peso * valor. Los booleanos valen 0 o 1.
  const senderScore = input.senderVerified ? 1 : 0;
  if (!input.senderVerified) reasons.push('sender_not_verified');

  const docScore = input.documentExtracted ? 1 : 0;
  if (!input.documentExtracted) reasons.push('document_not_extracted');

  const historyScore = input.priorHistoryMatches ? 1 : 0;
  if (!input.priorHistoryMatches) reasons.push('no_prior_history');

  if (input.amountMatch < 0.99) reasons.push('amount_mismatch');
  if (input.dateProximity < 0.5) reasons.push('date_far_off');

  const customClamped = clamp01(input.customWeight);

  // Score base aditivo (factores verificados).
  const additiveScore =
    input.amountMatch * WEIGHTS.amount +
    input.dateProximity * WEIGHTS.date +
    senderScore * WEIGHTS.sender +
    docScore * WEIGHTS.document +
    historyScore * WEIGHTS.history +
    customClamped * WEIGHTS.custom;

  // Veto multiplicativo: la confianza del OCR (customWeight) actúa como techo.
  // Si el OCR dice estar 50% seguro, el score final no puede superar 0.5,
  // sin importar que el monto y remitente coincidan. Esto evita auto-aprobar
  // facturas mal extraídas. Solo aplica si customWeight fue informado (>0).
  let score = additiveScore;
  if (customClamped > 0) {
    score = Math.min(score, customClamped);
  }

  score = clamp01(score);

  let decision: ConfidenceDecision;
  if (score >= threshold) {
    decision = 'auto_approve';
  } else if (score < rejectFloor) {
    decision = 'reject';
  } else {
    decision = 'review';
  }

  return { score, decision, reasons };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

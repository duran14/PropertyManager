/**
 * Funciones puras del adapter real de FrontLobby — sin Playwright, sin red,
 * completamente testeables. La orquestación con navegador vive en
 * `front-lobby.real.ts` y las importa.
 */

/** Umbral de score usado para el veredicto automático (Sección 8 del spec). */
export const CREDIT_SCORE_PASS_THRESHOLD = 620;

export function scoreToVerdict(score: number): 'passed' | 'flagged' {
  return score >= CREDIT_SCORE_PASS_THRESHOLD ? 'passed' : 'flagged';
}

/**
 * El summary persistido SIEMPRE deja claro que el veredicto es automático
 * por umbral, y SIEMPRE incluye el texto completo del resumen de IA de
 * FrontLobby — las señales de riesgo que ese texto mencione (colecciones,
 * bancarrota) no entran al umbral, pero el staff las sigue viendo aquí.
 */
export function formatAutomatedSummary(score: number, aiSummaryText: string): string {
  const verdict = scoreToVerdict(score);
  return `[AUTOMATED] Credit score ${score} — ${verdict} by threshold >=${CREDIT_SCORE_PASS_THRESHOLD}.\n\n${aiSummaryText}`;
}

const PROVIDER_REF_SEPARATOR = '|frontlobby|';

/**
 * FrontLobby no expuso (en el recorrido del formulario) un ID de
 * confirmación explícito tras enviar un checkeo — el `providerRef` se
 * compone con el nombre completo y el timestamp de envío, suficiente para
 * volver a encontrar la fila correcta en /tenant-screening/reports por
 * nombre más tarde (ver Sección 6-7 del spec). Si una corrida real expone
 * un ID propio de FrontLobby, usarlo en vez de este compuesto.
 */
export function encodeProviderRef(fullName: string, submittedAtIso: string): string {
  return `${fullName}${PROVIDER_REF_SEPARATOR}${submittedAtIso}`;
}

export function decodeProviderRef(providerRef: string): { fullName: string; submittedAtIso: string } {
  const [fullName, submittedAtIso] = providerRef.split(PROVIDER_REF_SEPARATOR);
  return { fullName: fullName ?? '', submittedAtIso: submittedAtIso ?? '' };
}

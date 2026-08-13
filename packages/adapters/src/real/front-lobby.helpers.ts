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

/**
 * Escapa metacaracteres de regex en un valor arbitrario (nombre de
 * solicitante, dirección) antes de usarlo para construir un `RegExp`
 * dinámico contra la tabla de FrontLobby. Sin esto, un apóstrofe o
 * paréntesis en el nombre (ej. "O'Brien (Jr.)") puede lanzar `SyntaxError`
 * DESPUÉS de que un checkeo real de $18.99 ya se haya enviado. Nunca
 * resuelve por sí solo el caso de un valor vacío — `new RegExp('', 'i')`
 * matchea todo; el llamador debe rechazar valores vacíos/solo espacios
 * ANTES de llegar aquí.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Intenta extraer una fecha de un texto de fila de la tabla
 * /tenant-screening/reports de FrontLobby. El formato exacto de la columna
 * "Date Created" no se pudo observar en el recorrido original que dio
 * origen a este adapter (la cuenta usada no tenía reportes generados
 * todavía) — se intentan dos patrones razonables: fecha ISO (`YYYY-MM-DD`)
 * y fecha larga en inglés (`Aug 13, 2026`). Si ninguno matchea, o el
 * candidato no parsea a una fecha válida, devuelve `null` y el llamador
 * debe tratarlo como "no se pudo determinar la fecha de esta fila" — esto
 * queda por verificar en la primera corrida real.
 */
export function parseRowDate(rowText: string): Date | null {
  const isoMatch = rowText.match(/\d{4}-\d{2}-\d{2}/);
  const longMatch = rowText.match(/[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}/);
  const candidate = isoMatch?.[0] ?? longMatch?.[0] ?? null;
  if (!candidate) return null;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Umbral mínimo de confianza del OCR de GLM (`CreditReportExtraction.confidence`)
 * para confiar en el score extraído del PDF. 0.5 es un punto de partida
 * conservador y arbitrario — no viene del spec, ajustar si corridas reales
 * muestran falsos negativos/positivos.
 */
export const CREDIT_EXTRACTION_MIN_CONFIDENCE = 0.5;

export function isExtractionConfident(confidence: number): boolean {
  return confidence >= CREDIT_EXTRACTION_MIN_CONFIDENCE;
}

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
 * True si `candidateDate` (normalmente el resultado ya truncado a día que
 * devuelve `parseRowDate`) cae en el mismo día calendario (UTC) que
 * `submittedAtIso`, o después — con 24h de tolerancia hacia atrás sobre el
 * piso de comparación. Se compara por día calendario, no por timestamp
 * exacto: `parseRowDate` casi siempre solo puede leer una fecha sin hora
 * de la fila de la tabla, y el reporte normalmente se genera horas
 * después del envío el MISMO día — comparar contra el timestamp completo
 * del envío (con hora) descartaría ese caso normal casi siempre.
 *
 * La tolerancia de 24h existe porque `parseRowDate` puede parsear su
 * segundo patrón ("Aug 13, 2026") como medianoche LOCAL del proceso que
 * corre el worker (comportamiento de `new Date(string)` en JS para fechas
 * no-ISO), mientras que este truncado siempre usa UTC — en cualquier huso
 * horario detrás de UTC (Europe/London, Europe/Berlin, Asia/Tokyo,
 * Australia/Sydney, etc.) esas dos medianoches no coinciden y, sin esta
 * tolerancia, una fila del MISMO día del envío nunca matchearía: el
 * checkeo se quedaría en `pending` para siempre (agotando reintentos)
 * aunque el reporte ya se haya generado y pagado. El costo de esta
 * tolerancia — aceptar de más una fila del día calendario anterior — es
 * mucho menor que no matchear nunca, y sigue descartando reportes viejos
 * de semanas atrás (el motivo original de este filtro por fecha). Si
 * `submittedAtIso` no parsea a una fecha válida, devuelve `false` (no hay
 * base para decidir "en o después").
 */
export function isOnOrAfterSubmittedDay(candidateDate: Date, submittedAtIso: string): boolean {
  const submittedAt = new Date(submittedAtIso);
  if (Number.isNaN(submittedAt.getTime())) return false;
  const submittedAtDayStart = Date.UTC(
    submittedAt.getUTCFullYear(),
    submittedAt.getUTCMonth(),
    submittedAt.getUTCDate(),
  );
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  return candidateDate.getTime() >= submittedAtDayStart - ONE_DAY_MS;
}

/**
 * Elige, entre los textos crudos de las filas ya filtradas por nombre en
 * /tenant-screening/reports, el ÍNDICE de la fila que corresponde al checkeo
 * recién enviado (`submittedAtIso`, decodificado del providerRef). Devuelve
 * `null` si ninguna fila tiene una fecha parseable que caiga en o después
 * del día de envío — el llamador debe tratar eso como `pending` y volver a
 * sondear, NUNCA adivinar una fila (adivinar mal persistiría el veredicto de
 * crédito de otro checkeo o solicitante).
 *
 * Se elige la fila de fecha MÁS RECIENTE entre las candidatas, no la primera
 * que matchee en orden del DOM. Motivo: la tolerancia de 24h de
 * `isOnOrAfterSubmittedDay` hace que una fila del día calendario ANTERIOR
 * también pueda matchear, así que un re-screening del mismo solicitante
 * dentro de ~48h (caso normal: el primer checkeo salió `flagged` y el manager
 * lo corre de nuevo) puede dejar DOS filas candidatas — la vieja y la nueva.
 * Quedarse con la primera del DOM ataría el resultado al orden de la tabla,
 * que nunca se observó en una corrida real; comparar las fechas ya parseadas
 * es lógica pura e independiente de ese orden. Ante empate exacto de fecha
 * (típico cuando `parseRowDate` solo lee el día, sin hora) se conserva la
 * primera — no hay más información disponible para desempatar.
 */
export function pickReportRowIndex(rowTexts: string[], submittedAtIso: string): number | null {
  let bestIndex: number | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < rowTexts.length; i += 1) {
    const candidateDate = parseRowDate(rowTexts[i] ?? '');
    if (!candidateDate) continue;
    if (!isOnOrAfterSubmittedDay(candidateDate, submittedAtIso)) continue;
    const candidateTime = candidateDate.getTime();
    if (candidateTime > bestTime) {
      bestTime = candidateTime;
      bestIndex = i;
    }
  }
  return bestIndex;
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

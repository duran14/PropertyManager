import { describe, expect, it } from 'vitest';
import {
  decodeProviderRef,
  encodeProviderRef,
  escapeRegExp,
  formatAutomatedSummary,
  isExtractionConfident,
  isOnOrAfterSubmittedDay,
  parseRowDate,
  scoreToVerdict,
} from './front-lobby.helpers.js';

describe('scoreToVerdict', () => {
  it('score >= 620 es passed', () => {
    expect(scoreToVerdict(620)).toBe('passed');
    expect(scoreToVerdict(900)).toBe('passed');
  });
  it('score < 620 es flagged', () => {
    expect(scoreToVerdict(619)).toBe('flagged');
    expect(scoreToVerdict(300)).toBe('flagged');
  });
});

describe('formatAutomatedSummary', () => {
  it('etiqueta el summary como automático y conserva el texto completo', () => {
    const result = formatAutomatedSummary(675, 'The applicant has a good credit history.');
    expect(result).toMatch(/^\[AUTOMATED\]/);
    expect(result).toContain('675');
    expect(result).toContain('passed by threshold');
    expect(result).toContain('The applicant has a good credit history.');
  });
});

describe('encodeProviderRef / decodeProviderRef', () => {
  it('hace round-trip del nombre completo y el timestamp', () => {
    const ref = encodeProviderRef('Jane Prospect', '2026-08-13T10:00:00.000Z');
    const decoded = decodeProviderRef(ref);
    expect(decoded.fullName).toBe('Jane Prospect');
    expect(decoded.submittedAtIso).toBe('2026-08-13T10:00:00.000Z');
  });
});

describe('escapeRegExp', () => {
  it('escapa metacaracteres de regex para que no rompan new RegExp(...)', () => {
    const escaped = escapeRegExp("O'Brien (Jr.)");
    expect(() => new RegExp(escaped, 'i')).not.toThrow();
  });

  it('el patrón escapado matchea el texto original literal, no como regex', () => {
    const escaped = escapeRegExp('Jane (Prospect)');
    expect(new RegExp(escaped, 'i').test('Jane (Prospect)')).toBe(true);
    expect(new RegExp(escaped, 'i').test('Jane XProspectX')).toBe(false);
  });
});

describe('parseRowDate', () => {
  it('parsea una fecha ISO embebida en texto de fila', () => {
    const parsed = parseRowDate('Jane Prospect 2026-08-13 Complete');
    expect(parsed).not.toBeNull();
    expect(parsed?.getUTCFullYear()).toBe(2026);
  });

  it('parsea una fecha larga en inglés embebida en texto de fila', () => {
    const parsed = parseRowDate('Jane Prospect Aug 13, 2026 Complete');
    expect(parsed).not.toBeNull();
    expect(parsed?.getUTCFullYear()).toBe(2026);
  });

  it('devuelve null si no encuentra un patrón de fecha reconocible', () => {
    expect(parseRowDate('Jane Prospect Complete')).toBeNull();
  });
});

describe('isOnOrAfterSubmittedDay', () => {
  it('una fila del MISMO día calendario (UTC) que el envío cuenta, aunque la hora del envío sea posterior', () => {
    // Caso normal: el envío ocurre a las 15:00 UTC, pero parseRowDate solo
    // pudo leer la fecha sin hora de la fila (medianoche UTC de ese mismo
    // día) — comparar por timestamp completo descartaría esto por error.
    const rowDateAtMidnight = new Date('2026-08-13T00:00:00.000Z');
    expect(isOnOrAfterSubmittedDay(rowDateAtMidnight, '2026-08-13T15:00:00.000Z')).toBe(true);
  });

  it('una fila de un día calendario posterior cuenta', () => {
    const rowDate = new Date('2026-08-14T00:00:00.000Z');
    expect(isOnOrAfterSubmittedDay(rowDate, '2026-08-13T15:00:00.000Z')).toBe(true);
  });

  it('una fila del día calendario anterior SÍ cuenta — tolerancia de 24h sobre el piso de comparación', () => {
    // La tolerancia existe porque el segundo patrón de parseRowDate
    // ("Aug 13, 2026") se parsea como medianoche LOCAL del proceso, no
    // UTC — en un huso detrás de UTC, una fila del MISMO día del envío
    // puede caer, en términos UTC, en el día calendario anterior. Sin
    // tolerancia, esa fila (que sí es del envío correcto) nunca matchea.
    const rowDate = new Date('2026-08-12T00:00:00.000Z');
    expect(isOnOrAfterSubmittedDay(rowDate, '2026-08-13T15:00:00.000Z')).toBe(true);
  });

  it('una fila de DOS días calendario antes (fuera de la tolerancia de 24h) NO cuenta', () => {
    const rowDate = new Date('2026-08-11T00:00:00.000Z');
    expect(isOnOrAfterSubmittedDay(rowDate, '2026-08-13T15:00:00.000Z')).toBe(false);
  });

  it('un submittedAtIso que no parsea nunca cuenta como match (no se adivina)', () => {
    const rowDate = new Date('2026-08-13T00:00:00.000Z');
    expect(isOnOrAfterSubmittedDay(rowDate, 'not-a-date')).toBe(false);
  });

  it('regresión: una fila parseada DE VERDAD con el patrón "Aug 13, 2026" (parseado como medianoche LOCAL del proceso, no UTC) matchea el envío del mismo día calendario, sin importar el huso horario del host', () => {
    // A diferencia de los tests de arriba, que construyen el Date a mano
    // en UTC, este usa parseRowDate de verdad — así es como se reprodujo
    // NUEVO-6: en Europe/London, Europe/Berlin, Asia/Tokyo,
    // Australia/Sydney, etc. el Date resultante de "Aug 13, 2026" no cae
    // en medianoche UTC del 13, y sin la tolerancia de 24h el match fallaba
    // silenciosamente (el checkeo se quedaba en pending para siempre).
    const submittedAtIso = '2026-08-13T15:00:00.000Z';
    const rowDate = parseRowDate('Jane Prospect Aug 13, 2026 Complete');
    expect(rowDate).not.toBeNull();
    expect(isOnOrAfterSubmittedDay(rowDate!, submittedAtIso)).toBe(true);
  });
});

describe('isExtractionConfident', () => {
  it('confidence >= 0.5 se considera confiable', () => {
    expect(isExtractionConfident(0.5)).toBe(true);
    expect(isExtractionConfident(0.9)).toBe(true);
  });

  it('confidence < 0.5 no se considera confiable', () => {
    expect(isExtractionConfident(0.49)).toBe(false);
    expect(isExtractionConfident(0)).toBe(false);
  });
});

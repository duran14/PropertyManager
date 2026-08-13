import { describe, expect, it } from 'vitest';
import {
  decodeProviderRef,
  encodeProviderRef,
  escapeRegExp,
  formatAutomatedSummary,
  isExtractionConfident,
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

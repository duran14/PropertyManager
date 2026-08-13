import { describe, expect, it } from 'vitest';
import { decodeProviderRef, encodeProviderRef, formatAutomatedSummary, scoreToVerdict } from './front-lobby.helpers.js';

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

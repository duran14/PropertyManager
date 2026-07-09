import { describe, expect, it } from 'vitest';
import { decide, type ConfidenceInput } from './confidence.js';

describe('confidence scoring (HITL)', () => {
  const baseInput: ConfidenceInput = {
    amountMatch: 1,
    dateProximity: 1,
    senderVerified: true,
    documentExtracted: true,
    priorHistoryMatches: true,
    customWeight: 0,
  };

  it('auto-aprueba cuando la confianza supera el umbral', () => {
    const result = decide(baseInput, { threshold: 0.85 });
    expect(result.decision).toBe('auto_approve');
    expect(result.score).toBeGreaterThanOrEqual(0.85);
  });

  it('envía a revisión humana cuando está justo debajo del umbral', () => {
    const input: ConfidenceInput = {
      ...baseInput,
      amountMatch: 0.6, // monto no coincide perfecto
      senderVerified: false,
    };
    const result = decide(input, { threshold: 0.85 });
    expect(result.decision).toBe('review');
    expect(result.score).toBeLessThan(0.85);
  });

  it('rechaza cuando la confianza es muy baja (probable error)', () => {
    const input: ConfidenceInput = {
      amountMatch: 0,
      dateProximity: 0,
      senderVerified: false,
      documentExtracted: false,
      priorHistoryMatches: false,
      customWeight: 0,
    };
    const result = decide(input, { threshold: 0.85 });
    expect(result.decision).toBe('reject');
    expect(result.score).toBeLessThan(0.3);
  });

  it('el score siempre está entre 0 y 1', () => {
    const inputs: ConfidenceInput[] = [
      { ...baseInput, amountMatch: 0.5 },
      { ...baseInput, amountMatch: 1, customWeight: 1 },
      { ...baseInput, amountMatch: 0, customWeight: -1 },
    ];
    for (const input of inputs) {
      const result = decide(input, { threshold: 0.5 });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('siempre explica qué factores bajaron la confianza', () => {
    const input: ConfidenceInput = {
      ...baseInput,
      senderVerified: false,
      documentExtracted: false,
    };
    const result = decide(input, { threshold: 0.85 });
    expect(result.reasons).toContain('sender_not_verified');
    expect(result.reasons).toContain('document_not_extracted');
  });
});

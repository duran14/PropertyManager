import { describe, expect, it } from 'vitest';
import { normalizeShowingDuration } from './scheduling.service.js';

describe('scheduling service', () => {
  it('accepts supported showing durations and defaults missing values', () => {
    expect(normalizeShowingDuration(undefined)).toBe(30);
    expect(normalizeShowingDuration(45)).toBe(45);
  });

  it('rejects unsupported showing durations', () => {
    expect(() => normalizeShowingDuration(20)).toThrow('Showing duration must be 15, 30, 45, or 60 minutes');
  });
});

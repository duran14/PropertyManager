import { describe, expect, it } from 'vitest';

import {
  normalizeRentalProfilePatch,
  parseConversationTurn,
} from './rental-conversation.types.js';

describe('parseConversationTurn', () => {
  it('trims profile values and normalizes a dog preference', () => {
    expect(parseConversationTurn({
      reply: 'Got it.',
      intent: 'discover',
      confidence: 'high',
      profile: {
        set: { prospect_name: ' Carlos ', bedrooms: ' 2 ', pets: 'DOGS' },
        clear: [],
      },
    })).toMatchObject({
      profile: { set: { prospect_name: 'Carlos', bedrooms: '2', pets: 'dog' } },
    });
  });

  it('rejects profile updates for fields outside the contract', () => {
    expect(() => parseConversationTurn({
      reply: 'x',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { made_up_field: 'x' }, clear: [] },
    })).toThrow(/profile/i);
  });

  it('rejects intent values outside the contract', () => {
    expect(() => parseConversationTurn({
      reply: 'x',
      intent: 'invent',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    })).toThrow();
  });
});

describe('normalizeRentalProfilePatch', () => {
  it('normalizes profile values without changing declared fields to clear', () => {
    expect(normalizeRentalProfilePatch({
      set: { pets: 'DOGS', budget: ' 2500 ' },
      clear: ['move_in_date'],
    })).toEqual({
      set: { pets: 'dog', budget: '2500' },
      clear: ['move_in_date'],
    });
  });
});

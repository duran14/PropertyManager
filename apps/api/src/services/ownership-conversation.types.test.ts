import { describe, expect, it } from 'vitest';
import {
  normalizeOwnershipProfilePatch,
  parseOwnershipConversationTurn,
} from './ownership-conversation.types.js';

describe('parseOwnershipConversationTurn', () => {
  it('trims profile values for a buyer turn', () => {
    expect(parseOwnershipConversationTurn({
      reply: 'Got it.',
      intent: 'discover',
      confidence: 'high',
      profile: {
        set: { prospect_name: ' Sarah ', purchase_budget: ' 850000 ' },
        clear: [],
      },
    })).toMatchObject({
      profile: { set: { prospect_name: 'Sarah', purchase_budget: '850000' } },
    });
  });

  it('rejects profile fields outside the buyer/seller contract', () => {
    expect(() => parseOwnershipConversationTurn({
      reply: 'x',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { made_up_field: 'x' }, clear: [] },
    })).toThrow(/profile/i);
  });

  it('rejects intents outside discover/handoff/other', () => {
    expect(() => parseOwnershipConversationTurn({
      reply: 'x',
      intent: 'select_unit',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    })).toThrow();
  });
});

describe('normalizeOwnershipProfilePatch', () => {
  it('normalizes a patch without altering declared clears', () => {
    expect(normalizeOwnershipProfilePatch({
      set: { seller_property_address: ' 12 Main St ' },
      clear: ['selling_timeline'],
    })).toEqual({
      set: { seller_property_address: '12 Main St' },
      clear: ['selling_timeline'],
    });
  });
});

import type { GlmAdapter, GlmReasoningRequest } from '@property-manager/adapters';
import { describe, expect, it, vi } from 'vitest';
import type { AvailableUnit } from './chatbot.service.js';
import {
  buildRentalConversationPrompt,
  interpretRentalTurn,
  type ConversationContext,
} from './rental-conversation.interpreter.js';

const visibleUnit: AvailableUnit = {
  id: 'unit-410',
  name: 'Suite 410',
  rentCents: 245000,
  city: 'Burnaby',
  province: 'British Columbia',
  propertyName: 'Cedar House',
  address: '4100 Hastings Street',
  bedrooms: 2,
  bathrooms: 1,
  availableFrom: new Date('2026-09-01T00:00:00.000Z'),
  petPolicy: 'Cats allowed',
};

function conversationContext(): ConversationContext {
  return {
    tenantName: 'North Shore Rentals',
    history: [
      { role: 'user', content: 'My name is Carla and I need two bedrooms.' },
      { role: 'assistant', content: 'What area works for you?' },
    ],
    profile: { prospect_name: 'Carla', bedrooms: '2' },
    selectedUnitId: 'unit-410',
    pendingSlotCount: 3,
    visibleUnits: [visibleUnit],
    knowledgeContext: 'Tours require 24 hours notice.',
  };
}

function glmReturning(content: string): {
  glm: GlmAdapter;
  reason: ReturnType<typeof vi.fn<(request: GlmReasoningRequest) => Promise<{ content: string }>>>;
} {
  const reason = vi.fn(async (_request: GlmReasoningRequest) => ({ content }));
  return { glm: { name: 'glm', reason } as unknown as GlmAdapter, reason };
}

const safeClarification = {
  reply: 'Could you clarify that in one sentence?',
  intent: 'other',
  confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] },
} as const;

describe('rental conversation interpreter', () => {
  it('preserves correction rules, short clarification guidance, and visible unit facts in the prompt', () => {
    const prompt = buildRentalConversationPrompt(conversationContext());

    expect(prompt).toContain('Corrections replace only the contradicted field');
    expect(prompt).toContain('Ask one short clarification question');
    expect(prompt).toContain('"id":"unit-410"');
    expect(prompt).toContain('"city":"Burnaby"');
  });

  it('requests a strict ConversationTurn schema and returns the validated model turn', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Thanks Carlos. I kept your two-bedroom preference.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { prospect_name: 'Carlos' }, clear: [] },
    }));

    const result = await interpretRentalTurn({
      glm,
      context: conversationContext(),
      message: 'Sorry, Carlos.',
    });

    expect(result).toEqual({
      reply: 'Thanks Carlos. I kept your two-bedroom preference.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { prospect_name: 'Carlos' }, clear: [] },
    });
    const request = reason.mock.calls[0]?.[0];
    expect(request?.userPrompt).toBe('Sorry, Carlos.');
    expect(request?.responseSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['reply', 'intent', 'confidence', 'profile'],
      properties: {
        profile: {
          type: 'object',
          additionalProperties: false,
          required: ['set', 'clear'],
        },
      },
    });
  });

  it('returns a low-confidence clarification without a profile patch for malformed JSON', async () => {
    const { glm } = glmReturning('{not-json');

    await expect(interpretRentalTurn({
      glm,
      context: conversationContext(),
      message: 'Something else',
    })).resolves.toEqual(safeClarification);
  });

  it('returns the same safe clarification for schema failures and provider failures', async () => {
    const invalid = glmReturning(JSON.stringify({ reply: 'Incomplete' })).glm;
    const failing = {
      name: 'glm',
      reason: vi.fn(async () => { throw new Error('provider unavailable'); }),
    } as unknown as GlmAdapter;

    await expect(interpretRentalTurn({
      glm: invalid,
      context: conversationContext(),
      message: 'Incomplete response',
    })).resolves.toEqual(safeClarification);
    await expect(interpretRentalTurn({
      glm: failing,
      context: conversationContext(),
      message: 'Provider failure',
    })).resolves.toEqual(safeClarification);
  });
});

import type { GlmAdapter, GlmReasoningRequest } from '@property-manager/adapters';
import { describe, expect, it, vi } from 'vitest';
import {
  buildOwnershipConversationPrompt,
  interpretOwnershipTurn,
  type OwnershipConversationContext,
} from './ownership-conversation.interpreter.js';

function conversationContext(): OwnershipConversationContext {
  return {
    tenantName: 'North Shore Realty',
    history: [
      { role: 'user', content: 'I want to buy a home.' },
      { role: 'assistant', content: 'May I ask your first name?' },
    ],
    profile: { transaction_intent: 'buy', prospect_name: 'Sara' },
    knowledgeContext: 'Pre-approval required before offers.',
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

describe('ownership conversation interpreter', () => {
  it('includes the qualification-only guardrail and context facts in the prompt', () => {
    const prompt = buildOwnershipConversationPrompt(conversationContext());
    expect(prompt).toContain('never claim a viewing, offer, or contract has been created');
    expect(prompt).toContain('"prospect_name":"Sara"');
  });

  it('inlines the actual JSON Schema as text, since Z.ai only supports response_format: json_object (no json_schema mode) and documents the schema as belonging in the prompt text, not a separate request field', () => {
    const prompt = buildOwnershipConversationPrompt(conversationContext());

    expect(prompt).toContain('MUST validate against exactly this JSON Schema');
    expect(prompt).toContain('"reply"');
    expect(prompt).toContain('"intent"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"profile"');
    expect(prompt).toContain('"purchase_budget"');
    expect(prompt).toContain('"seller_goal"');
  });

  it('returns the validated model turn for a rich qualifying message', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: 'Got it — a $850k budget for a townhouse in Burnaby.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { purchase_budget: '850000', buyer_property_type: 'townhouse', preferred_area: 'Burnaby' }, clear: [] },
    }));

    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'My budget is around 850k for a townhouse in Burnaby.',
    })).resolves.toEqual({
      turn: {
        reply: 'Got it — a $850k budget for a townhouse in Burnaby.',
        intent: 'discover',
        confidence: 'high',
        profile: { set: { purchase_budget: '850000', buyer_property_type: 'townhouse', preferred_area: 'Burnaby' }, clear: [] },
      },
      providerFailed: false,
    });
  });

  it('flags malformed JSON as a provider failure', async () => {
    const { glm } = glmReturning('{not-json');
    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'Something else',
    })).resolves.toEqual({ turn: safeClarification, providerFailed: true });
  });

  it('removes profile mutations from a low-confidence clarification', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: 'Which neighbourhood did you mean?',
      intent: 'discover',
      confidence: 'low',
      clarification: { question: 'Which neighbourhood did you mean?' },
      profile: { set: { preferred_area: 'somewhere' }, clear: ['purchase_budget'] },
    }));

    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'Somewhere nice, I guess.',
    })).resolves.toEqual({
      turn: {
        reply: 'Which neighbourhood did you mean?',
        intent: 'discover',
        confidence: 'low',
        clarification: { question: 'Which neighbourhood did you mean?' },
        profile: { set: {}, clear: [] },
      },
      providerFailed: false,
    });
  });

  it('returns handoff intent once the model determines qualification is complete', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: "I'll connect you with our buying specialist now.",
      intent: 'handoff',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    }));

    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'That covers everything I think.',
    })).resolves.toEqual({
      turn: {
        reply: "I'll connect you with our buying specialist now.",
        intent: 'handoff',
        confidence: 'high',
        profile: { set: {}, clear: [] },
      },
      providerFailed: false,
    });
  });
});

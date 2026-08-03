import type { GlmAdapter } from '@property-manager/adapters';
import {
  parseOwnershipConversationTurn,
  type OwnershipConversationSemanticTurn,
  type OwnershipProfile,
} from './ownership-conversation.types.js';

export type OwnershipConversationContext = {
  tenantName: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  profile: OwnershipProfile;
  knowledgeContext: string;
};

const ownershipConversationTurnJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    intent: { type: 'string', enum: ['discover', 'handoff', 'other'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
    clarification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        field: {
          type: 'string',
          enum: [
            'prospect_name', 'transaction_intent', 'preferred_area', 'preferred_province',
            'buyer_property_type', 'bedrooms', 'purchase_budget', 'financing_status',
            'purchase_timeline', 'buyer_urgency', 'buyer_household', 'buyer_pets',
            'buyer_priorities', 'contact_email', 'contact_phone', 'seller_property_address',
            'seller_property_type', 'seller_bedrooms', 'occupancy_status', 'selling_timeline',
            'seller_goal',
          ],
        },
      },
      required: ['question'],
    },
    profile: {
      type: 'object',
      additionalProperties: false,
      properties: {
        set: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prospect_name: { type: 'string' },
            transaction_intent: { type: 'string' },
            preferred_area: { type: 'string' },
            preferred_province: { type: 'string' },
            buyer_property_type: { type: 'string' },
            bedrooms: { type: 'string' },
            purchase_budget: { type: 'string' },
            financing_status: { type: 'string' },
            purchase_timeline: { type: 'string' },
            buyer_urgency: { type: 'string' },
            buyer_household: { type: 'string' },
            buyer_pets: { type: 'string' },
            buyer_priorities: { type: 'string' },
            contact_email: { type: 'string' },
            contact_phone: { type: 'string' },
            seller_property_address: { type: 'string' },
            seller_property_type: { type: 'string' },
            seller_bedrooms: { type: 'string' },
            occupancy_status: { type: 'string' },
            selling_timeline: { type: 'string' },
            seller_goal: { type: 'string' },
          },
        },
        clear: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'prospect_name', 'transaction_intent', 'preferred_area', 'preferred_province',
              'buyer_property_type', 'bedrooms', 'purchase_budget', 'financing_status',
              'purchase_timeline', 'buyer_urgency', 'buyer_household', 'buyer_pets',
              'buyer_priorities', 'contact_email', 'contact_phone', 'seller_property_address',
              'seller_property_type', 'seller_bedrooms', 'occupancy_status', 'selling_timeline',
              'seller_goal',
            ],
          },
        },
      },
      required: ['set', 'clear'],
    },
  },
  required: ['reply', 'intent', 'confidence', 'profile'],
};

const safeClarification: OwnershipConversationSemanticTurn = {
  reply: 'Could you clarify that in one sentence?',
  intent: 'other',
  confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] },
};

export type InterpretOwnershipResult = {
  turn: OwnershipConversationSemanticTurn;
  providerFailed: boolean;
};

export function buildOwnershipConversationPrompt(context: OwnershipConversationContext): string {
  return [
    'Interpret the current home buying/selling conversation message and return only one JSON object matching the response schema.',
    'This is qualification only: never claim a viewing, offer, or contract has been created. There is no inventory to recommend and no booking to make here.',
    'Corrections replace only the contradicted field. Preserve every uncontradicted fact already present in the profile and history.',
    "Ask one short clarification question when the user's meaning is uncertain. When uncertain, return confidence: 'low' and leave the profile patch empty unless the fact is explicit.",
    "Return intent: 'handoff' once enough of the relevant buyer or seller fields are known to hand off to a human broker (area, property type, budget/timeline for buyers; address, property type, timeline for sellers).",
    `Conversation context:\n${JSON.stringify({
      tenantName: context.tenantName,
      history: context.history,
      profile: context.profile,
      knowledgeContext: context.knowledgeContext,
    })}`,
  ].join('\n');
}

export async function interpretOwnershipTurn(input: {
  glm: GlmAdapter;
  context: OwnershipConversationContext;
  message: string;
}): Promise<InterpretOwnershipResult> {
  try {
    const response = await input.glm.reason({
      systemPrompt: buildOwnershipConversationPrompt(input.context),
      userPrompt: input.message,
      responseSchema: ownershipConversationTurnJsonSchema,
      temperature: 0.2,
    });
    const normalized = response.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const turn = parseOwnershipConversationTurn(JSON.parse(normalized));
    if (turn.confidence === 'low' && !turn.clarification) {
      return { turn: safeClarification, providerFailed: false };
    }
    if (turn.confidence === 'low') {
      return {
        turn: {
          reply: turn.reply,
          intent: turn.intent,
          confidence: 'low',
          clarification: turn.clarification,
          profile: { set: {}, clear: [] },
        },
        providerFailed: false,
      };
    }
    return { turn, providerFailed: false };
  } catch {
    return { turn: safeClarification, providerFailed: true };
  }
}

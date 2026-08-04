import type { GlmAdapter } from '@property-manager/adapters';
import type { AvailableUnit } from './chatbot.service.js';
import {
  parseConversationTurn,
  type ConversationTurn,
  type RentalProfile,
} from './rental-conversation.types.js';

export type ConversationContext = {
  tenantName: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  profile: RentalProfile;
  selectedUnitId?: string;
  pendingSlotCount: number;
  visibleUnits: AvailableUnit[];
  knowledgeContext: string;
};

const conversationTurnJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    intent: {
      type: 'string',
      enum: ['discover', 'compare', 'select_unit', 'request_tour', 'choose_slot', 'handoff', 'other'],
    },
    confidence: { type: 'string', enum: ['high', 'low'] },
    clarification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        field: {
          type: 'string',
          enum: [
            'prospect_name',
            'transaction_intent',
            'preferred_area',
            'preferred_province',
            'bedrooms',
            'bedrooms_min',
            'bedrooms_max',
            'pets',
            'budget',
            'occupants',
            'move_in_date',
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
            bedrooms: { type: 'string' },
            bedrooms_min: { type: 'string' },
            bedrooms_max: { type: 'string' },
            pets: { type: 'string' },
            budget: { type: 'string' },
            occupants: { type: 'string' },
            move_in_date: { type: 'string' },
          },
        },
        clear: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'prospect_name',
              'transaction_intent',
              'preferred_area',
              'preferred_province',
              'bedrooms',
              'bedrooms_min',
              'bedrooms_max',
              'pets',
              'budget',
              'occupants',
              'move_in_date',
            ],
          },
        },
      },
      required: ['set', 'clear'],
    },
    selection: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unitIds: { type: 'array', items: { type: 'string' } },
        slotIndex: { type: 'integer' },
      },
    },
  },
  required: ['reply', 'intent', 'confidence', 'profile'],
};

const safeClarification: ConversationTurn = {
  reply: 'Could you clarify that in one sentence?',
  intent: 'other',
  confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] },
};

export type InterpretRentalResult = {
  turn: ConversationTurn;
  providerFailed: boolean;
};

export function buildRentalConversationPrompt(context: ConversationContext): string {
  return [
    'Interpret the current rental conversation message and return only one JSON object matching the response schema.',
    'Use the conversation context as factual input. Do not claim that a tour, handoff, message, or data update has been executed.',
    'Corrections replace only the contradicted field. Recognize corrections such as "sorry Carlos" as a replacement for the previously supplied name.',
    'Preserve every uncontradicted fact already present in the profile and history.',
    "Ask one short clarification question when the user's meaning or reference is uncertain.",
    "When uncertain, return confidence: 'low', include exactly one clarification question, and leave the profile patch empty unless the fact is explicit.",
    'Use a unit ID only when it appears in selectedUnitId or visibleUnits. Use a slotIndex only from the pending slot range.',
    'Never invent a unit ID or slot index.',
    'Keep "reply" to 2-3 sentences.',
    // La API de Z.ai no soporta response_format: json_schema (solo
    // json_object) — su propia documentación indica que el esquema debe
    // describirse como texto en el system prompt, no como parámetro aparte.
    // Reutilizamos el mismo objeto que se pasa a glm.reason() para que
    // nunca se desalinee de lo que en verdad se valida del lado del cliente.
    'The JSON object you return MUST validate against exactly this JSON Schema (no extra keys, respect every enum):',
    JSON.stringify(conversationTurnJsonSchema),
    `Conversation context:\n${JSON.stringify({
      tenantName: context.tenantName,
      history: context.history,
      profile: context.profile,
      selectedUnitId: context.selectedUnitId ?? null,
      pendingSlotCount: context.pendingSlotCount,
      visibleUnits: context.visibleUnits,
      knowledgeContext: context.knowledgeContext,
    })}`,
  ].join('\n');
}

function hasValidSelection(turn: ConversationTurn, context: ConversationContext): boolean {
  const allowedUnitIds = new Set([
    ...context.visibleUnits.map((unit) => unit.id),
    ...(context.selectedUnitId ? [context.selectedUnitId] : []),
  ]);
  const unitIdsAreValid = turn.selection?.unitIds?.every((unitId) => allowedUnitIds.has(unitId)) ?? true;
  const slotIndex = turn.selection?.slotIndex;
  const slotIndexIsValid = slotIndex === undefined
    || (slotIndex >= 0 && slotIndex < context.pendingSlotCount);
  return unitIdsAreValid && slotIndexIsValid;
}

export async function interpretRentalTurn(input: {
  glm: GlmAdapter;
  context: ConversationContext;
  message: string;
}): Promise<InterpretRentalResult> {
  try {
    const response = await input.glm.reason({
      systemPrompt: buildRentalConversationPrompt(input.context),
      userPrompt: input.message,
      responseSchema: conversationTurnJsonSchema,
      temperature: 0.2,
    });
    const normalized = response.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const turn = parseConversationTurn(JSON.parse(normalized));
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
    if (!hasValidSelection(turn, input.context)) {
      return { turn: safeClarification, providerFailed: false };
    }
    return { turn, providerFailed: false };
  } catch {
    return { turn: safeClarification, providerFailed: true };
  }
}

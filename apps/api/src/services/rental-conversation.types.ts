import { z } from 'zod';

export type RentalProfileField =
  | 'prospect_name'
  | 'transaction_intent'
  | 'preferred_area'
  | 'preferred_province'
  | 'bedrooms'
  | 'bedrooms_min'
  | 'bedrooms_max'
  | 'pets'
  | 'budget'
  | 'occupants'
  | 'move_in_date';

export type RentalProfile = Partial<Record<RentalProfileField, string>>;

export type ConversationTurn = {
  reply: string;
  intent: 'discover' | 'compare' | 'select_unit' | 'request_tour' | 'choose_slot' | 'handoff' | 'other';
  confidence: 'high' | 'low';
  clarification?: { question: string; field?: RentalProfileField };
  profile: { set: RentalProfile; clear: RentalProfileField[] };
  selection?: { unitIds?: string[]; slotIndex?: number };
};

const rentalProfileFieldSchema = z.enum([
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
]);

const normalizedStringSchema = z.string().transform((value) => value.trim());
const petsSchema = normalizedStringSchema.transform((value) => (
  value.toLowerCase() === 'dogs' ? 'dog' : value
));

const rentalProfileSchema = z.object({
  prospect_name: normalizedStringSchema.optional(),
  transaction_intent: normalizedStringSchema.optional(),
  preferred_area: normalizedStringSchema.optional(),
  preferred_province: normalizedStringSchema.optional(),
  bedrooms: normalizedStringSchema.optional(),
  bedrooms_min: normalizedStringSchema.optional(),
  bedrooms_max: normalizedStringSchema.optional(),
  pets: petsSchema.optional(),
  budget: normalizedStringSchema.optional(),
  occupants: normalizedStringSchema.optional(),
  move_in_date: normalizedStringSchema.optional(),
}).strict();

const rentalProfilePatchSchema = z.object({
  set: rentalProfileSchema,
  clear: z.array(rentalProfileFieldSchema),
}).strict();

const conversationTurnSchema = z.object({
  reply: normalizedStringSchema,
  intent: z.enum(['discover', 'compare', 'select_unit', 'request_tour', 'choose_slot', 'handoff', 'other']),
  confidence: z.enum(['high', 'low']),
  clarification: z.object({
    question: normalizedStringSchema,
    field: rentalProfileFieldSchema.optional(),
  }).strict().optional(),
  profile: rentalProfilePatchSchema,
  selection: z.object({
    unitIds: z.array(normalizedStringSchema).optional(),
    slotIndex: z.number().int().optional(),
  }).strict().optional(),
}).strict();

export function parseConversationTurn(value: unknown): ConversationTurn {
  return conversationTurnSchema.parse(value);
}

export function normalizeRentalProfilePatch(
  input: ConversationTurn['profile'],
): ConversationTurn['profile'] {
  return rentalProfilePatchSchema.parse(input);
}

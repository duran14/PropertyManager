import { z } from 'zod';

export type OwnershipProfileField =
  | 'prospect_name'
  | 'transaction_intent'
  | 'preferred_area'
  | 'preferred_province'
  | 'buyer_property_type'
  | 'bedrooms'
  | 'purchase_budget'
  | 'financing_status'
  | 'purchase_timeline'
  | 'buyer_urgency'
  | 'buyer_household'
  | 'buyer_pets'
  | 'buyer_priorities'
  | 'contact_email'
  | 'contact_phone'
  | 'seller_property_address'
  | 'seller_property_type'
  | 'seller_bedrooms'
  | 'occupancy_status'
  | 'selling_timeline'
  | 'seller_goal';

export type OwnershipProfile = Partial<Record<OwnershipProfileField, string>>;

export type OwnershipConversationSemanticTurn = {
  reply: string;
  intent: 'discover' | 'handoff' | 'other';
  confidence: 'high' | 'low';
  clarification?: { question: string; field?: OwnershipProfileField };
  profile: { set: OwnershipProfile; clear: OwnershipProfileField[] };
};

const ownershipProfileFieldSchema = z.enum([
  'prospect_name',
  'transaction_intent',
  'preferred_area',
  'preferred_province',
  'buyer_property_type',
  'bedrooms',
  'purchase_budget',
  'financing_status',
  'purchase_timeline',
  'buyer_urgency',
  'buyer_household',
  'buyer_pets',
  'buyer_priorities',
  'contact_email',
  'contact_phone',
  'seller_property_address',
  'seller_property_type',
  'seller_bedrooms',
  'occupancy_status',
  'selling_timeline',
  'seller_goal',
]);

const normalizedStringSchema = z.string().transform((value) => value.trim());

const ownershipProfileSchema = z.object({
  prospect_name: normalizedStringSchema.optional(),
  transaction_intent: normalizedStringSchema.optional(),
  preferred_area: normalizedStringSchema.optional(),
  preferred_province: normalizedStringSchema.optional(),
  buyer_property_type: normalizedStringSchema.optional(),
  bedrooms: normalizedStringSchema.optional(),
  purchase_budget: normalizedStringSchema.optional(),
  financing_status: normalizedStringSchema.optional(),
  purchase_timeline: normalizedStringSchema.optional(),
  buyer_urgency: normalizedStringSchema.optional(),
  buyer_household: normalizedStringSchema.optional(),
  buyer_pets: normalizedStringSchema.optional(),
  buyer_priorities: normalizedStringSchema.optional(),
  contact_email: normalizedStringSchema.optional(),
  contact_phone: normalizedStringSchema.optional(),
  seller_property_address: normalizedStringSchema.optional(),
  seller_property_type: normalizedStringSchema.optional(),
  seller_bedrooms: normalizedStringSchema.optional(),
  occupancy_status: normalizedStringSchema.optional(),
  selling_timeline: normalizedStringSchema.optional(),
  seller_goal: normalizedStringSchema.optional(),
}).strict();

const ownershipProfilePatchSchema = z.object({
  set: ownershipProfileSchema,
  clear: z.array(ownershipProfileFieldSchema),
}).strict();

const ownershipConversationTurnSchema = z.object({
  reply: normalizedStringSchema,
  intent: z.enum(['discover', 'handoff', 'other']),
  confidence: z.enum(['high', 'low']),
  clarification: z.object({
    question: normalizedStringSchema,
    field: ownershipProfileFieldSchema.optional(),
  }).strict().optional(),
  profile: ownershipProfilePatchSchema,
}).strict();

export function parseOwnershipConversationTurn(value: unknown): OwnershipConversationSemanticTurn {
  return ownershipConversationTurnSchema.parse(value);
}

export function normalizeOwnershipProfilePatch(
  input: OwnershipConversationSemanticTurn['profile'],
): OwnershipConversationSemanticTurn['profile'] {
  return ownershipProfilePatchSchema.parse(input);
}

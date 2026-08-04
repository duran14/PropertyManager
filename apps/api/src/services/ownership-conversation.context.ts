import type { Prisma } from '@prisma/client';
import {
  normalizeOwnershipProfilePatch,
  type OwnershipConversationSemanticTurn,
  type OwnershipProfile,
  type OwnershipProfileField,
} from './ownership-conversation.types.js';

const ownershipProfileFields: OwnershipProfileField[] = [
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
];

export async function applyOwnershipProfilePatch(input: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  conversationId: string;
  leadId?: string | null;
  patch: OwnershipConversationSemanticTurn['profile'];
}): Promise<OwnershipProfile> {
  const patch = normalizeOwnershipProfilePatch(input.patch);

  if (patch.clear.length > 0) {
    await input.tx.conversationSlot.deleteMany({
      where: {
        conversationId: input.conversationId,
        key: { in: patch.clear },
      },
    });
  }

  for (const [key, value] of Object.entries(patch.set)) {
    await input.tx.conversationSlot.upsert({
      where: {
        conversationId_key: {
          conversationId: input.conversationId,
          key,
        },
      },
      update: { value },
      create: {
        conversationId: input.conversationId,
        key,
        value,
      },
    });
  }

  const correctedName = patch.set.prospect_name
    ?? (patch.clear.includes('prospect_name') ? null : undefined);
  if (input.leadId && correctedName !== undefined) {
    await input.tx.lead.updateMany({
      where: { id: input.leadId, tenantId: input.tenantId },
      data: { name: correctedName },
    });
  }

  const finalSlots = await input.tx.conversationSlot.findMany({
    where: {
      conversationId: input.conversationId,
      key: { in: ownershipProfileFields },
    },
    select: { key: true, value: true },
  });

  return finalSlots.reduce<OwnershipProfile>((profile: OwnershipProfile, slot: { key: string; value: string }) => {
    profile[slot.key as OwnershipProfileField] = slot.value;
    return profile;
  }, {});
}

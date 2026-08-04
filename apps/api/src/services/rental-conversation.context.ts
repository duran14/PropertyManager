import type { Prisma } from '@prisma/client';
import {
  normalizeRentalProfilePatch,
  type ConversationTurn,
  type RentalProfile,
  type RentalProfileField,
} from './rental-conversation.types.js';

const rentalProfileFields: RentalProfileField[] = [
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
];

export async function applyRentalProfilePatch(input: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  conversationId: string;
  leadId?: string | null;
  patch: ConversationTurn['profile'];
}): Promise<RentalProfile> {
  const patch = normalizeRentalProfilePatch(input.patch);

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
      key: { in: rentalProfileFields },
    },
    select: { key: true, value: true },
  });

  return finalSlots.reduce<RentalProfile>((profile: RentalProfile, slot: { key: string; value: string }) => {
    profile[slot.key as RentalProfileField] = slot.value;
    return profile;
  }, {});
}

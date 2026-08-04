import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { applyOwnershipProfilePatch } from './ownership-conversation.context.js';

function ownershipProfileTransaction(initialSlots: Record<string, string>) {
  const slots = new Map(Object.entries(initialSlots));
  let leadName: string | null = 'Sara';

  const tx = {
    conversationSlot: {
      deleteMany: vi.fn(async ({ where }: {
        where: { conversationId: string; key: { in: string[] } };
      }) => {
        let count = 0;
        for (const key of where.key.in) {
          if (slots.delete(key)) count += 1;
        }
        return { count };
      }),
      upsert: vi.fn(async ({ where, update }: {
        where: { conversationId_key: { conversationId: string; key: string } };
        update: { value: string };
      }) => {
        const { key } = where.conversationId_key;
        slots.set(key, update.value);
        return { key, value: update.value };
      }),
      findMany: vi.fn(async () => (
        [...slots].map(([key, value]) => ({ key, value }))
      )),
    },
    lead: {
      updateMany: vi.fn(async ({ data }: { data: { name: string | null } }) => {
        leadName = data.name;
        return { count: 1 };
      }),
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, getLeadName: () => leadName };
}

describe('applyOwnershipProfilePatch', () => {
  it('corrects the prospect name without losing the purchase budget', async () => {
    const db = ownershipProfileTransaction({
      prospect_name: 'Sara',
      purchase_budget: '850000',
    });

    const profile = await applyOwnershipProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      patch: { set: { prospect_name: 'Sarah' }, clear: [] },
    });

    expect(profile).toEqual({
      prospect_name: 'Sarah',
      purchase_budget: '850000',
    });
    expect(db.getLeadName()).toBe('Sarah');
  });

  it('applies set values after clears when both target the same field', async () => {
    const db = ownershipProfileTransaction({
      prospect_name: 'Sara',
      seller_property_type: 'condo',
    });

    const profile = await applyOwnershipProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      patch: {
        clear: ['seller_property_type'],
        set: { seller_property_type: 'townhouse' },
      },
    });

    expect(profile).toEqual({
      prospect_name: 'Sara',
      seller_property_type: 'townhouse',
    });
  });
});

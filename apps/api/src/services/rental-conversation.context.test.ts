import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { applyRentalProfilePatch } from './rental-conversation.context.js';

function rentalProfileTransaction(initialSlots: Record<string, string>) {
  const slots = new Map(Object.entries(initialSlots));
  let leadName: string | null = 'Carlops';

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

describe('applyRentalProfilePatch', () => {
  it('corrects the prospect name without losing the preferred area', async () => {
    const db = rentalProfileTransaction({
      prospect_name: 'Carlops',
      preferred_area: 'Burnaby',
    });

    const profile = await applyRentalProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      patch: { set: { prospect_name: 'Carlos' }, clear: [] },
    });

    expect(profile).toEqual({
      prospect_name: 'Carlos',
      preferred_area: 'Burnaby',
    });
    expect(db.getLeadName()).toBe('Carlos');
  });

  it('applies set values after clears when both target the same field', async () => {
    const db = rentalProfileTransaction({
      prospect_name: 'Carlops',
      preferred_area: 'Burnaby',
    });

    const profile = await applyRentalProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      patch: {
        clear: ['preferred_area'],
        set: { preferred_area: 'Richmond' },
      },
    });

    expect(profile).toEqual({
      prospect_name: 'Carlops',
      preferred_area: 'Richmond',
    });
  });
});

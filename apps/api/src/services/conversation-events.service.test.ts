import { describe, expect, it } from 'vitest';
import { createConversationEvent } from './conversation-events.service.js';

describe('conversation events service', () => {
  it('creates a staff event with normalized labels and details', async () => {
    const writes: unknown[] = [];
    const event = await createConversationEvent(
      {
        tenantId: 'tenant_1',
        conversationId: 'conversation_1',
        leadId: 'lead_1',
        type: 'lead.status_changed',
        actorUserId: 'user_1',
        payload: { fromStatus: 'contacted', toStatus: 'qualified' },
      },
      {
        conversationEvent: {
          create: async (input: unknown) => {
            writes.push(input);
            return {
              id: 'event_1',
              createdAt: new Date('2026-07-10T09:05:00.000Z'),
              ...(input as { data: Record<string, unknown> }).data,
            };
          },
        },
      },
    );

    expect(writes).toHaveLength(1);
    expect(event).toMatchObject({
      id: 'event_1',
      type: 'lead.status_changed',
      label: 'Lead status changed',
      detail: 'Contacted to qualified',
      tone: 'active',
    });
  });
});

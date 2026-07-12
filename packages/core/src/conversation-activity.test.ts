import { describe, expect, it } from 'vitest';
import { buildConversationActivity } from './conversation-activity.js';

describe('buildConversationActivity', () => {
  it('orders recent conversation events from newest to oldest', () => {
    const activity = buildConversationActivity({
      lead: { status: 'tour_scheduled', createdAt: '2026-07-10T09:00:00.000Z' },
      recommendedUnit: {
        unitName: 'Apt 102',
        propertyName: 'Cedar Court Apartments',
        updatedAt: '2026-07-10T09:05:00.000Z',
      },
      slots: [
        { key: 'budget', value: '2700 CAD', updatedAt: '2026-07-10T09:06:00.000Z' },
        { key: 'move_in_date', value: '2026-07-15', updatedAt: '2026-07-10T09:07:00.000Z' },
      ],
      messages: [
        { role: 'user', content: 'Tomorrow at 3 works.', createdAt: '2026-07-10T09:10:00.000Z' },
      ],
      showings: [
        {
          status: 'scheduled',
          scheduledAt: '2026-07-12T17:00:00.000Z',
          createdAt: '2026-07-10T09:12:00.000Z',
        },
      ],
    });

    expect(activity.map((item) => item.label)).toEqual([
      'Tour scheduled',
      'Prospect replied',
      'Profile enriched',
      'Unit recommendation active',
      'Lead created',
    ]);
    expect(activity[0]).toMatchObject({
      detail: 'Jul 12, 10:00 a.m.',
      tone: 'active',
    });
  });

  it('flags cancelled showings as attention events', () => {
    const activity = buildConversationActivity({
      lead: null,
      recommendedUnit: null,
      slots: [],
      messages: [],
      showings: [
        {
          status: 'cancelled',
          scheduledAt: '2026-07-12T17:00:00.000Z',
          updatedAt: '2026-07-10T10:00:00.000Z',
        },
      ],
    });

    expect(activity).toEqual([
      {
        key: 'showing-0',
        label: 'Tour cancelled',
        detail: 'Jul 12, 10:00 a.m.',
        occurredAt: '2026-07-10T10:00:00.000Z',
        tone: 'attention',
        source: 'derived',
      },
    ]);
  });

  it('prioritizes persisted staff events with actor names', () => {
    const activity = buildConversationActivity({
      lead: null,
      recommendedUnit: null,
      slots: [],
      messages: [
        { role: 'user', content: 'Can I tour today?', createdAt: '2026-07-10T09:00:00.000Z' },
      ],
      showings: [],
      events: [
        {
          id: 'event_1',
          type: 'lead.status_changed',
          label: 'Lead status changed',
          detail: 'Contacted to qualified',
          actorName: 'Diana Reyes',
          createdAt: '2026-07-10T09:05:00.000Z',
          tone: 'active',
        },
      ],
    });

    expect(activity[0]).toEqual({
      key: 'event-event_1',
      label: 'Lead status changed',
      detail: 'Contacted to qualified',
      occurredAt: '2026-07-10T09:05:00.000Z',
      tone: 'active',
      source: 'event',
      actorName: 'Diana Reyes',
    });
  });
});

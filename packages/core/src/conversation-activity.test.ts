import { describe, expect, it } from 'vitest';
import { buildConversationActivity, filterConversationActivity } from './conversation-activity.js';

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
        category: 'showings',
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
      category: 'staff',
      source: 'event',
      actorName: 'Diana Reyes',
    });
  });

  it('does not duplicate showings that already have persisted events', () => {
    const activity = buildConversationActivity({
      lead: null,
      recommendedUnit: null,
      slots: [],
      messages: [],
      showings: [
        {
          id: 'showing_1',
          status: 'cancelled',
          scheduledAt: '2026-07-12T17:00:00.000Z',
          updatedAt: '2026-07-10T10:00:00.000Z',
        },
      ],
      events: [
        {
          id: 'event_1',
          type: 'showing.cancelled',
          label: 'Tour cancelled',
          detail: 'Jul 12, 10:00 a.m.',
          createdAt: '2026-07-10T10:01:00.000Z',
          relatedShowingId: 'showing_1',
        },
      ],
    });

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      key: 'event-event_1',
      source: 'event',
    });
  });

  it('filters activity by operational category', () => {
    const activity = buildConversationActivity({
      lead: { status: 'tour_scheduled', createdAt: '2026-07-10T08:00:00.000Z' },
      recommendedUnit: null,
      slots: [{ key: 'budget', value: '2700', updatedAt: '2026-07-10T08:10:00.000Z' }],
      messages: [
        { role: 'user', content: 'I can tour tomorrow.', createdAt: '2026-07-10T08:20:00.000Z' },
      ],
      showings: [
        {
          id: 'showing_1',
          status: 'scheduled',
          scheduledAt: '2026-07-12T17:00:00.000Z',
          createdAt: '2026-07-10T08:30:00.000Z',
        },
      ],
      events: [
        {
          id: 'event_1',
          type: 'lead.status_changed',
          label: 'Lead status changed',
          detail: 'New to contacted',
          createdAt: '2026-07-10T08:40:00.000Z',
        },
      ],
    });

    expect(filterConversationActivity(activity, 'staff').map((item) => item.label)).toEqual([
      'Lead status changed',
    ]);
    expect(filterConversationActivity(activity, 'messages').map((item) => item.label)).toEqual([
      'Prospect replied',
    ]);
    expect(filterConversationActivity(activity, 'profile').map((item) => item.label)).toEqual([
      'Profile enriched',
      'Lead created',
    ]);
    expect(filterConversationActivity(activity, 'showings').map((item) => item.label)).toEqual([
      'Tour scheduled',
    ]);
    expect(filterConversationActivity(activity, 'all')).toHaveLength(activity.length);
  });

  it('groups internal notes with staff actions', () => {
    const activity = buildConversationActivity({
      lead: null,
      recommendedUnit: null,
      slots: [],
      messages: [],
      showings: [],
      events: [
        {
          id: 'event_1',
          type: 'note.internal_added',
          label: 'Internal note added',
          detail: 'Call after 4 p.m.',
          createdAt: '2026-07-10T08:40:00.000Z',
        },
      ],
    });

    expect(filterConversationActivity(activity, 'staff').map((item) => item.label)).toEqual([
      'Internal note added',
    ]);
  });
});

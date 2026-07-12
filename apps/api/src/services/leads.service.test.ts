import { describe, expect, it } from 'vitest';
import {
  buildLeadProspectProfile,
  summarizeLatestLeadActivity,
  isLeadStatus,
} from './leads.service.js';

describe('lead prospect profile', () => {
  it('summarizes captured chatbot slots from the most recent conversations', () => {
    const profile = buildLeadProspectProfile([
      {
        channel: 'sms',
        state: 'collecting_budget',
        updatedAt: new Date('2026-07-11T05:00:00Z'),
        slots: [
          { key: 'budget', value: '2400' },
          { key: 'move_in_date', value: 'August' },
        ],
      },
      {
        channel: 'whatsapp',
        state: 'proposing_tour',
        updatedAt: new Date('2026-07-11T06:00:00Z'),
        slots: [
          { key: 'preferred_area', value: 'Burnaby' },
          { key: 'occupants', value: '2' },
          { key: 'pets', value: 'cat' },
        ],
      },
    ]);

    expect(profile).toEqual({
      budget: '2400',
      moveInDate: 'August',
      preferredArea: 'Burnaby',
      occupants: '2',
      pets: 'cat',
      lastChannel: 'whatsapp',
      conversationState: 'proposing_tour',
    });
  });

  it('accepts only known lead funnel statuses', () => {
    expect(isLeadStatus('tour_scheduled')).toBe(true);
    expect(isLeadStatus('needs_callback')).toBe(false);
  });

  it('summarizes the newest lead activity event', () => {
    const activity = summarizeLatestLeadActivity([
      {
        label: 'Internal note added',
        detail: 'Call after 4 p.m.',
        createdAt: new Date('2026-07-10T08:30:00.000Z'),
      },
      {
        label: 'Human handoff requested',
        detail: 'Needs broker follow-up',
        createdAt: new Date('2026-07-10T09:30:00.000Z'),
      },
    ]);

    expect(activity).toEqual({
      label: 'Human handoff requested',
      detail: 'Needs broker follow-up',
      createdAt: '2026-07-10T09:30:00.000Z',
    });
  });
});

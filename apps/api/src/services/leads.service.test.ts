import { describe, expect, it } from 'vitest';
import { buildLeadProspectProfile } from './leads.service.js';

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
});

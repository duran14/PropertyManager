import { describe, expect, it } from 'vitest';
import {
  buildStaffOverrideMatchReason,
  buildUnitMatchReason,
  getConversationExternalId,
  getExistingLeadChannelUpdate,
  getReplyAddressFromConversation,
  rankMatchingUnits,
} from './chatbot.service.js';

describe('chatbot conversation identity', () => {
  it('keeps SMS and WhatsApp conversations separate for the same phone number', () => {
    const phone = '+16045551792';

    expect(getConversationExternalId({ channel: 'sms', from: phone })).toBe('sms:+16045551792');
    expect(getConversationExternalId({ channel: 'whatsapp', from: phone })).toBe('whatsapp:+16045551792');
  });

  it('strips channel prefixes before sending replies', () => {
    expect(getReplyAddressFromConversation('sms:+16045551792')).toBe('+16045551792');
    expect(getReplyAddressFromConversation('whatsapp:+16045551792')).toBe('+16045551792');
    expect(getReplyAddressFromConversation('telegram:12345')).toBe('12345');
    expect(getReplyAddressFromConversation('web_session_1')).toBe('web_session_1');
  });

  it('keeps first-touch source while updating the preferred channel', () => {
    expect(getExistingLeadChannelUpdate('whatsapp')).toEqual({ preferredChannel: 'whatsapp' });
    expect(getExistingLeadChannelUpdate('sms')).toEqual({ preferredChannel: 'sms' });
  });

  it('ranks active units by budget, area, pets, beds, and availability', () => {
    const ranked = rankMatchingUnits(
      [
        {
          id: 'unit_a',
          name: 'Apt 101',
          propertyName: 'Cedar Court',
          city: 'Vancouver',
          rentCents: 240000,
          bedrooms: 1,
          bathrooms: 1,
          availableFrom: new Date('2026-08-01T00:00:00.000Z'),
          petPolicy: 'Cats allowed',
        },
        {
          id: 'unit_b',
          name: 'Suite 12',
          propertyName: 'Burnaby Heights',
          city: 'Burnaby',
          rentCents: 260000,
          bedrooms: 2,
          bathrooms: 1.5,
          availableFrom: new Date('2026-08-15T00:00:00.000Z'),
          petPolicy: 'Pet friendly',
        },
      ],
      {
        budget: '2600',
        preferred_area: 'Burnaby',
        pets: 'cat',
        occupants: '2',
        move_in_date: 'August',
      },
    );

    expect(ranked[0].id).toBe('unit_b');
    expect(buildUnitMatchReason(ranked[0], {
      budget: '2600',
      preferred_area: 'Burnaby',
      pets: 'cat',
      occupants: '2',
      move_in_date: 'August',
    })).toContain('matches the Burnaby area');
  });

  it('describes a staff-selected unit recommendation override', () => {
    expect(buildStaffOverrideMatchReason('Burnaby Heights', 'Suite 12')).toBe(
      'Selected by staff override: Burnaby Heights Suite 12.',
    );
  });
});

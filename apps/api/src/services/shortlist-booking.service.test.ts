import { describe, expect, it } from 'vitest';
import { parseShortlistBooking } from './shortlist-booking.service.js';

describe('parseShortlistBooking', () => {
  it('accepts and trims complete contact details for a tour', () => {
    expect(parseShortlistBooking({
      slotIndex: 2,
      name: '  Laura  ',
      phone: ' +1 604 555 0199 ',
      email: ' LAURA@example.com ',
      notes: '  Please call before arriving.  ',
    })).toEqual({
      slotIndex: 2,
      name: 'Laura',
      phone: '+1 604 555 0199',
      email: 'laura@example.com',
      notes: 'Please call before arriving.',
    });
  });

  it('requires a valid name, phone, email, and slot', () => {
    expect(() => parseShortlistBooking({
      slotIndex: -1,
      name: '',
      phone: '',
      email: 'not-an-email',
    })).toThrow('Invalid booking details');
  });
});

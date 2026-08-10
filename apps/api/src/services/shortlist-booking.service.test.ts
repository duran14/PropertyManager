import { describe, expect, it } from 'vitest';
import { parseShortlistBooking } from './shortlist-booking.service.js';

describe('parseShortlistBooking', () => {
  it('accepts and trims complete contact details for a tour', () => {
    expect(parseShortlistBooking({
      startAt: '2026-08-10T18:00:00.000Z',
      name: '  Laura  ',
      phone: ' +1 604 555 0199 ',
      email: ' LAURA@example.com ',
      notes: '  Please call before arriving.  ',
    })).toEqual({
      startAt: '2026-08-10T18:00:00.000Z',
      name: 'Laura',
      phone: '+1 604 555 0199',
      email: 'laura@example.com',
      notes: 'Please call before arriving.',
    });
  });

  it('requires a valid name, phone, email, and slot', () => {
    expect(() => parseShortlistBooking({
      startAt: 'not-a-date',
      name: '',
      phone: '',
      email: 'not-an-email',
    })).toThrow('Invalid booking details');
  });
});

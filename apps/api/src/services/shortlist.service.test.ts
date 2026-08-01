import { describe, expect, it } from 'vitest';
import { buildShortlistPrefillContact, hashShortlistToken, nextReminderDate } from './shortlist.service.js';

describe('shortlist lifecycle', () => {
  it('hashes public tokens without storing the token itself', () => {
    expect(hashShortlistToken('secret-token')).toHaveLength(64);
    expect(hashShortlistToken('secret-token')).not.toContain('secret-token');
  });

  it('schedules only the three agreed follow-ups', () => {
    const created = new Date('2026-07-30T12:00:00.000Z');
    expect(nextReminderDate(created, 0)?.toISOString()).toBe('2026-07-30T14:00:00.000Z');
    expect(nextReminderDate(created, 1)?.toISOString()).toBe('2026-07-31T12:00:00.000Z');
    expect(nextReminderDate(created, 2)?.toISOString()).toBe('2026-08-02T12:00:00.000Z');
    expect(nextReminderDate(created, 3)).toBeNull();
  });

  it('prefills only the name from the active conversation and leaves phone and email blank by default', () => {
    expect(buildShortlistPrefillContact(
      { prospect_name: 'Mike' },
      { name: 'Mike', phone: '747353317', email: 'carlos.duran.1410@gmail.com' },
    )).toEqual({
      name: 'Mike',
      phone: '',
      email: '',
    });
  });
});

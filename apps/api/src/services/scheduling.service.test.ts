import { describe, expect, it } from 'vitest';
import {
  buildShowingConfirmationEmail,
  buildProspectSlotKey,
  canCancelShowingStatus,
  canConfirmShowingStatus,
  normalizeShowingDuration,
  resolveShowingBooking,
  sendShowingConfirmationEmail,
} from './scheduling.service.js';

describe('scheduling service', () => {
  it('accepts supported showing durations and defaults missing values', () => {
    expect(normalizeShowingDuration(undefined)).toBe(30);
    expect(normalizeShowingDuration(45)).toBe(45);
  });

  it('rejects unsupported showing durations', () => {
    expect(() => normalizeShowingDuration(20)).toThrow('Showing duration must be 15, 30, 45, or 60 minutes');
  });

  it('allows showing actions only for active showing states', () => {
    expect(canConfirmShowingStatus('scheduled')).toBe(true);
    expect(canConfirmShowingStatus('cancelled')).toBe(false);
    expect(canCancelShowingStatus('scheduled')).toBe(true);
    expect(canCancelShowingStatus('confirmed')).toBe(true);
    expect(canCancelShowingStatus('completed')).toBe(false);
  });

  it('treats a repeat booking for the same unit as idempotent and blocks a different unit at that time', () => {
    const existing = {
      id: 'showing-1',
      unitId: 'unit-burnaby',
      showmojoUrl: 'https://showmojo.example/showing-1',
      scheduledAt: new Date('2026-08-03T21:00:00.000Z'),
    };

    expect(resolveShowingBooking(existing, 'unit-burnaby')).toEqual({ kind: 'existing' });
    expect(resolveShowingBooking(existing, 'unit-kelowna')).toEqual({ kind: 'conflict' });
    expect(resolveShowingBooking(null, 'unit-burnaby')).toEqual({ kind: 'new' });
  });

  it('uses one active slot key for the same prospect email across different leads', () => {
    const scheduledAt = new Date('2026-08-03T17:00:00.000Z');
    expect(buildProspectSlotKey({ leadId: 'lead-1', email: 'LIDIA@example.com' }, scheduledAt))
      .toBe(buildProspectSlotKey({ leadId: 'lead-2', email: 'lidia@example.com' }, scheduledAt));
  });

  it('builds a confirmation email with the showing details', () => {
    expect(buildShowingConfirmationEmail({
      prospectName: 'Miguel',
      propertyLabel: 'Burnaby Heights Lofts — Loft 410',
      address: '4100 Hastings St, Burnaby, BC',
      scheduledAt: new Date('2026-08-03T21:00:00.000Z'),
    })).toContain('Your property tour is confirmed');
  });

  it('delivers the confirmation email to the prospect address', async () => {
    const send = async (message: { to: string; channel: string; body: string }) => {
      expect(message).toMatchObject({
        to: 'miguel@example.ca',
        channel: 'email',
      });
      return { messageId: 'email-1' };
    };

    await expect(sendShowingConfirmationEmail({
      recipient: 'miguel@example.ca',
      body: 'Your property tour is confirmed.',
      send,
    })).resolves.toEqual({ messageId: 'email-1' });
  });
});

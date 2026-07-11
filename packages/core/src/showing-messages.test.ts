import { describe, expect, it } from 'vitest';
import { buildShowingSuggestedReply, stageSuggestedReply } from './showing-messages.js';

describe('showing suggested replies', () => {
  it('suggests a confirmation message with the tour details', () => {
    const message = buildShowingSuggestedReply({
      action: 'confirmed',
      scheduledAt: '2026-07-12T17:00:00.000Z',
      unitName: 'Apt 102',
      propertyName: 'Cedar Court Apartments',
    });

    expect(message).toContain('Your tour is confirmed');
    expect(message).toContain('Cedar Court Apartments Apt 102');
  });

  it('suggests a rescheduling message after cancellation', () => {
    expect(buildShowingSuggestedReply({
      action: 'cancelled',
      scheduledAt: '2026-07-12T17:00:00.000Z',
      unitName: 'Apt 102',
      propertyName: 'Cedar Court Apartments',
    })).toBe('No problem, we can reschedule your tour for Cedar Court Apartments Apt 102. Would another morning or afternoon work better for you?');
  });

  it('uses a suggestion immediately only when the reply box is empty', () => {
    expect(stageSuggestedReply('', 'Suggested copy')).toEqual({
      reply: 'Suggested copy',
      pendingSuggestion: null,
    });
    expect(stageSuggestedReply('Already typing', 'Suggested copy')).toEqual({
      reply: 'Already typing',
      pendingSuggestion: 'Suggested copy',
    });
  });
});

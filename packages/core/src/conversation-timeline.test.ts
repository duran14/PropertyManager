import { describe, expect, it } from 'vitest';
import { buildConversationTimeline } from './conversation-timeline.js';

describe('buildConversationTimeline', () => {
  it('summarizes a qualified lead with a scheduled tour and pending reply', () => {
    expect(
      buildConversationTimeline({
        hasLead: true,
        hasRecommendedUnit: true,
        showingStatuses: ['scheduled'],
        hasPendingSuggestedReply: true,
      }),
    ).toEqual([
      { key: 'lead', label: 'Lead captured', tone: 'done' },
      { key: 'unit', label: 'Unit recommended', tone: 'done' },
      { key: 'tour', label: 'Tour scheduled', tone: 'active' },
      { key: 'reply', label: 'Reply waiting', tone: 'attention' },
    ]);
  });

  it('flags cancelled tours as needing a reschedule', () => {
    expect(
      buildConversationTimeline({
        hasLead: true,
        hasRecommendedUnit: false,
        showingStatuses: ['cancelled'],
        hasPendingSuggestedReply: false,
      }),
    ).toEqual([
      { key: 'lead', label: 'Lead captured', tone: 'done' },
      { key: 'unit', label: 'Unit not selected', tone: 'muted' },
      { key: 'tour', label: 'Tour needs reschedule', tone: 'attention' },
    ]);
  });
});

export type ConversationTimelineTone = 'done' | 'active' | 'attention' | 'muted';

export interface ConversationTimelineInput {
  hasLead: boolean;
  hasRecommendedUnit: boolean;
  showingStatuses: string[];
  hasPendingSuggestedReply: boolean;
}

export interface ConversationTimelineItem {
  key: string;
  label: string;
  tone: ConversationTimelineTone;
}

export function buildConversationTimeline(
  input: ConversationTimelineInput,
): ConversationTimelineItem[] {
  const items: ConversationTimelineItem[] = [
    {
      key: 'lead',
      label: input.hasLead ? 'Lead captured' : 'Lead not captured',
      tone: input.hasLead ? 'done' : 'muted',
    },
    {
      key: 'unit',
      label: input.hasRecommendedUnit ? 'Unit recommended' : 'Unit not selected',
      tone: input.hasRecommendedUnit ? 'done' : 'muted',
    },
    buildTourTimelineItem(input.showingStatuses),
  ];

  if (input.hasPendingSuggestedReply) {
    items.push({ key: 'reply', label: 'Reply waiting', tone: 'attention' });
  }

  return items;
}

function buildTourTimelineItem(showingStatuses: string[]): ConversationTimelineItem {
  if (showingStatuses.length === 0) {
    return { key: 'tour', label: 'Tour not scheduled', tone: 'muted' };
  }

  if (showingStatuses.includes('confirmed')) {
    return { key: 'tour', label: 'Tour confirmed', tone: 'done' };
  }

  if (showingStatuses.includes('scheduled')) {
    return { key: 'tour', label: 'Tour scheduled', tone: 'active' };
  }

  if (showingStatuses.includes('cancelled')) {
    return { key: 'tour', label: 'Tour needs reschedule', tone: 'attention' };
  }

  return { key: 'tour', label: 'Tour history updated', tone: 'done' };
}

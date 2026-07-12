export type ConversationActivityTone = 'neutral' | 'active' | 'attention' | 'done';

export interface ConversationActivityInput {
  lead: { status: string; createdAt?: string } | null;
  recommendedUnit: { unitName: string; propertyName: string; updatedAt?: string } | null;
  slots: Array<{ key: string; value: string; updatedAt?: string }>;
  messages: Array<{ role: string; content: string; createdAt: string }>;
  showings: Array<{
    status: string;
    scheduledAt: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}

export interface ConversationActivityItem {
  key: string;
  label: string;
  detail: string;
  occurredAt: string;
  tone: ConversationActivityTone;
}

const PROFILE_SLOT_LABELS: Record<string, string> = {
  budget: 'budget',
  move_in_date: 'move-in',
  preferred_area: 'area',
  occupants: 'people',
  pets: 'pets',
};

export function buildConversationActivity(
  input: ConversationActivityInput,
): ConversationActivityItem[] {
  const activity: ConversationActivityItem[] = [];

  input.showings.forEach((showing, index) => {
    const label = buildShowingLabel(showing.status);
    activity.push({
      key: `showing-${index}`,
      label,
      detail: formatActivityDateTime(showing.scheduledAt),
      occurredAt: showing.updatedAt ?? showing.createdAt ?? showing.scheduledAt,
      tone: buildShowingTone(showing.status),
    });
  });

  const latestUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === 'user');
  if (latestUserMessage) {
    activity.push({
      key: 'latest-user-message',
      label: 'Prospect replied',
      detail: truncateDetail(latestUserMessage.content),
      occurredAt: latestUserMessage.createdAt,
      tone: 'neutral',
    });
  }

  const profileSlots = input.slots.filter((slot) => PROFILE_SLOT_LABELS[slot.key]);
  if (profileSlots.length > 0) {
    activity.push({
      key: 'profile',
      label: 'Profile enriched',
      detail: profileSlots
        .slice(0, 3)
        .map((slot) => `${slot.value} ${PROFILE_SLOT_LABELS[slot.key]}`)
        .join(', '),
      occurredAt: latestTimestamp(profileSlots.map((slot) => slot.updatedAt)),
      tone: 'done',
    });
  }

  if (input.recommendedUnit) {
    activity.push({
      key: 'unit',
      label: 'Unit recommendation active',
      detail: `${input.recommendedUnit.propertyName} ${input.recommendedUnit.unitName}`,
      occurredAt: input.recommendedUnit.updatedAt ?? '',
      tone: 'done',
    });
  }

  if (input.lead) {
    activity.push({
      key: 'lead',
      label: 'Lead created',
      detail: formatLeadStatus(input.lead.status),
      occurredAt: input.lead.createdAt ?? '',
      tone: 'done',
    });
  }

  return activity
    .filter((item) => item.occurredAt)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

function buildShowingLabel(status: string): string {
  if (status === 'confirmed') return 'Tour confirmed';
  if (status === 'cancelled') return 'Tour cancelled';
  if (status === 'completed') return 'Tour completed';
  if (status === 'no_show') return 'Tour no-show';
  return 'Tour scheduled';
}

function buildShowingTone(status: string): ConversationActivityTone {
  if (status === 'cancelled' || status === 'no_show') return 'attention';
  if (status === 'scheduled') return 'active';
  return 'done';
}

function latestTimestamp(values: Array<string | undefined>): string {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? ''
  );
}

function truncateDetail(value: string): string {
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

function formatLeadStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function formatActivityDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

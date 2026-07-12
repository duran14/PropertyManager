export type ConversationActivityTone = 'neutral' | 'active' | 'attention' | 'done';
export type ConversationActivityCategory = 'all' | 'staff' | 'messages' | 'profile' | 'showings';

export interface ConversationActivityInput {
  lead: { status: string; createdAt?: string } | null;
  recommendedUnit: { unitName: string; propertyName: string; updatedAt?: string } | null;
  slots: Array<{ key: string; value: string; updatedAt?: string }>;
  messages: Array<{ role: string; content: string; createdAt: string }>;
  showings: Array<{
    id?: string;
    status: string;
    scheduledAt: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
  events?: ConversationActivityEventInput[];
}

export interface ConversationActivityEventInput {
  id: string;
  type: string;
  label: string;
  detail: string;
  actorName?: string | null;
  createdAt: string;
  tone?: ConversationActivityTone;
  relatedShowingId?: string | null;
}

export interface ConversationActivityItem {
  key: string;
  label: string;
  detail: string;
  occurredAt: string;
  tone: ConversationActivityTone;
  category: Exclude<ConversationActivityCategory, 'all'>;
  source?: 'event' | 'derived';
  actorName?: string | null;
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
  const persistedShowingIds = new Set(
    (input.events ?? [])
      .map((event) => event.relatedShowingId)
      .filter((id): id is string => Boolean(id)),
  );
  const activity: ConversationActivityItem[] = (input.events ?? []).map((event) => ({
    key: `event-${event.id}`,
    label: event.label,
    detail: event.detail,
    occurredAt: event.createdAt,
    tone: event.tone ?? toneForEventType(event.type),
    category: categoryForEventType(event.type),
    source: 'event',
    actorName: event.actorName,
  }));

  input.showings.forEach((showing, index) => {
    if (showing.id && persistedShowingIds.has(showing.id)) return;

    const label = buildShowingLabel(showing.status);
    activity.push({
      key: `showing-${index}`,
      label,
      detail: formatActivityDateTime(showing.scheduledAt),
      occurredAt: showing.updatedAt ?? showing.createdAt ?? showing.scheduledAt,
      tone: buildShowingTone(showing.status),
      category: 'showings',
      source: 'derived',
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
      category: 'messages',
      source: 'derived',
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
      category: 'profile',
      source: 'derived',
    });
  }

  if (input.recommendedUnit) {
    activity.push({
      key: 'unit',
      label: 'Unit recommendation active',
      detail: `${input.recommendedUnit.propertyName} ${input.recommendedUnit.unitName}`,
      occurredAt: input.recommendedUnit.updatedAt ?? '',
      tone: 'done',
      category: 'profile',
      source: 'derived',
    });
  }

  if (input.lead) {
    activity.push({
      key: 'lead',
      label: 'Lead created',
      detail: formatLeadStatus(input.lead.status),
      occurredAt: input.lead.createdAt ?? '',
      tone: 'done',
      category: 'profile',
      source: 'derived',
    });
  }

  return activity
    .filter((item) => item.occurredAt)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

export function filterConversationActivity(
  activity: ConversationActivityItem[],
  category: ConversationActivityCategory,
): ConversationActivityItem[] {
  if (category === 'all') return activity;
  return activity.filter((item) => item.category === category);
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

function toneForEventType(type: string): ConversationActivityTone {
  if (type.includes('cancelled') || type.includes('handoff')) return 'attention';
  if (type.includes('scheduled') || type.includes('status_changed')) return 'active';
  if (type.includes('confirmed') || type.includes('recommended')) return 'done';
  return 'neutral';
}

function categoryForEventType(type: string): Exclude<ConversationActivityCategory, 'all'> {
  if (type.startsWith('showing.')) return 'showings';
  if (
    type.startsWith('lead.') ||
    type.startsWith('unit.') ||
    type.startsWith('staff.') ||
    type.startsWith('handoff.') ||
    type.startsWith('note.')
  ) {
    return 'staff';
  }
  return 'messages';
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

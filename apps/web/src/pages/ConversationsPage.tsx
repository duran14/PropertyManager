import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  buildConversationActivity,
  filterConversationActivity,
} from '@property-manager/core/conversation-activity';
import type {
  ConversationActivityCategory,
  ConversationActivityEventInput,
  ConversationActivityTone,
} from '@property-manager/core/conversation-activity';
import { buildConversationTimeline } from '@property-manager/core/conversation-timeline';
import type { ConversationTimelineTone } from '@property-manager/core/conversation-timeline';
import {
  buildShowingSuggestedReply,
  stageSuggestedReply,
} from '@property-manager/core/showing-messages';
import { apiFetch } from '../lib/apiClient';
import { Icon } from '../components/Icon';
import type { LeadStatus } from '../lib/types';

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  mediaUrls: string[];
  createdAt: string;
}

interface Conversation {
  id: string;
  externalId: string;
  channel: string;
  state: string;
  lead: {
    id: string;
    name: string | null;
    phone: string | null;
    status: LeadStatus;
    createdAt?: string;
  } | null;
  unit: {
    id: string;
    name: string;
    rentCents: number;
    property: { name: string; city: string };
  } | null;
  messages: ChatMessage[];
  slots: Array<{ key: string; value: string; updatedAt?: string }>;
  showings?: ShowingSummary[];
  events?: ConversationEventSummary[];
  updatedAt: string;
}

interface ConversationEventSummary {
  id: string;
  type: string;
  label: string;
  detail: string;
  tone: ConversationActivityTone;
  payload?: Record<string, unknown>;
  createdAt: string;
  actorUser?: { firstName: string; lastName: string } | null;
}

interface ShowingSummary {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  createdAt?: string;
  updatedAt?: string;
  unit: { name: string; property: { name: string; address: string; city: string } } | null;
}

interface UnitOption {
  id: string;
  name: string;
  rentCents: number;
  property: { name: string; city: string };
}

const CHANNEL_STYLES: Record<string, string> = {
  whatsapp: 'bg-green-50 text-green-700',
  telegram: 'bg-blue-50 text-blue-700',
  web: 'bg-violet-50 text-violet-700',
  sms: 'bg-sky-50 text-sky-700',
  email: 'bg-amber-50 text-amber-700',
};

const STATE_LABELS: Record<string, string> = {
  greeting: 'Greeting',
  collecting_budget: 'Collecting budget',
  collecting_movein: 'Collecting move-in date',
  proposing_units: 'Proposing units',
  proposing_tour: 'Offering tour',
  scheduling: 'Scheduling',
  handoff: 'Human handoff',
};

const TIMELINE_TONE_STYLES: Record<ConversationTimelineTone, string> = {
  done: 'border-green-200 bg-green-50 text-green-800',
  active: 'border-blue-200 bg-blue-50 text-blue-800',
  attention: 'border-amber-200 bg-amber-50 text-amber-900',
  muted: 'border-slate-200 bg-slate-50 text-slate-500',
};

const ACTIVITY_TONE_STYLES: Record<ConversationActivityTone, string> = {
  neutral: 'bg-slate-400',
  active: 'bg-blue-500',
  attention: 'bg-amber-500',
  done: 'bg-green-500',
};

const ACTIVITY_FILTER_OPTIONS: Array<{ value: ConversationActivityCategory; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'staff', label: 'Staff actions' },
  { value: 'messages', label: 'Messages' },
  { value: 'profile', label: 'Lead profile' },
  { value: 'showings', label: 'Showings' },
];

const LEAD_STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = [
  { value: 'new_', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'tour_scheduled', label: 'Tour scheduled' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'converted', label: 'Converted' },
  { value: 'lost', label: 'Lost' },
];

const SLOT_LABELS: Record<string, string> = {
  budget: 'Budget',
  move_in_date: 'Move-in',
  occupants: 'People',
  pets: 'Pets',
  preferred_area: 'Area',
  match_reason: 'Match',
};

function visibleSlots(slots: Array<{ key: string; value: string }>) {
  return slots.filter(
    (s) =>
      !s.key.startsWith('pending_') &&
      !s.key.startsWith('scheduling_') &&
      s.key !== 'recommended_unit_id',
  );
}

function slotValue(slots: Array<{ key: string; value: string }>, key: string): string | undefined {
  return slots.find((slot) => slot.key === key)?.value;
}

function slotUpdatedAt(
  slots: Array<{ key: string; value: string; updatedAt?: string }>,
  key: string,
): string | undefined {
  return slots.find((slot) => slot.key === key)?.updatedAt;
}

function defaultShowingDateTime(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  return toDateTimeLocalValue(date);
}

function toDateTimeLocalValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function formatShowingDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatActivityTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function toConversationActivityEvent(
  event: ConversationEventSummary,
): ConversationActivityEventInput {
  return {
    id: event.id,
    type: event.type,
    label: event.label,
    detail: event.detail,
    tone: event.tone,
    createdAt: event.createdAt,
    actorName: event.actorUser ? `${event.actorUser.firstName} ${event.actorUser.lastName}` : null,
    relatedShowingId: typeof event.payload?.showingId === 'string' ? event.payload.showingId : null,
  };
}

function canConfirmShowing(status: ShowingSummary['status']): boolean {
  return status === 'scheduled';
}

function canCancelShowing(status: ShowingSummary['status']): boolean {
  return status === 'scheduled' || status === 'confirmed';
}

function canRescheduleShowing(status: ShowingSummary['status']): boolean {
  return status === 'cancelled';
}

export function ConversationsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [pendingSuggestedReply, setPendingSuggestedReply] = useState<string | null>(null);
  const [showingDateTime, setShowingDateTime] = useState(defaultShowingDateTime);
  const [showingDuration, setShowingDuration] = useState(30);
  const [activityCategory, setActivityCategory] = useState<ConversationActivityCategory>('all');
  const [internalNote, setInternalNote] = useState('');
  const [handoffReason, setHandoffReason] = useState('');

  const { data, isLoading } = useQuery<{ conversations: Conversation[] }>({
    queryKey: ['conversations'],
    queryFn: () => apiFetch('/chat/conversations'),
  });

  const { data: detail } = useQuery<{ conversation: Conversation }>({
    queryKey: ['conversation', selectedId],
    queryFn: () => apiFetch(`/chat/conversations/${selectedId}`),
    enabled: !!selectedId,
  });

  const { data: unitsData } = useQuery<{ units: UnitOption[] }>({
    queryKey: ['units'],
    queryFn: () => apiFetch('/units'),
  });

  const replyMutation = useMutation({
    mutationFn: ({ id, message }: { id: string; message: string }) =>
      apiFetch<{
        status: string;
        message: { id: string; role: string; content: string; createdAt: string };
      }>(`/chat/conversations/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<{ conversation: Conversation }>(
        ['conversation', selectedId],
        (old) => {
          if (!old) return old;
          return {
            conversation: {
              ...old.conversation,
              messages: [
                ...old.conversation.messages,
                {
                  id: data.message.id,
                  role: data.message.role,
                  content: data.message.content,
                  mediaUrls: [],
                  createdAt: data.message.createdAt,
                },
              ],
            },
          };
        },
      );
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      setReply('');
      setPendingSuggestedReply(null);
    },
  });

  const recommendedUnitMutation = useMutation({
    mutationFn: ({ id, unitId }: { id: string; unitId: string }) =>
      apiFetch<{ conversation: Conversation }>(`/chat/conversations/${id}/recommended-unit`, {
        method: 'PATCH',
        body: JSON.stringify({ unitId }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<{ conversation: Conversation }>(
        ['conversation', data.conversation.id],
        data,
      );
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });

  const leadStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: LeadStatus }) =>
      apiFetch(`/leads/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<{ conversation: Conversation }>(
        ['conversation', selectedId],
        (old) => {
          if (!old?.conversation.lead) return old;
          return {
            conversation: {
              ...old.conversation,
              lead: { ...old.conversation.lead, status: variables.status },
            },
          };
        },
      );
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });

  const scheduleShowingMutation = useMutation({
    mutationFn: ({
      id,
      scheduledAt,
      durationMinutes,
    }: {
      id: string;
      scheduledAt: string;
      durationMinutes: number;
    }) =>
      apiFetch<{ showing: ShowingSummary }>(`/chat/conversations/${id}/showing`, {
        method: 'POST',
        body: JSON.stringify({
          scheduledAt: new Date(scheduledAt).toISOString(),
          durationMinutes,
        }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<{ conversation: Conversation }>(
        ['conversation', selectedId],
        (old) => {
          if (!old) return old;
          return {
            conversation: {
              ...old.conversation,
              state: 'scheduling',
              lead: old.conversation.lead
                ? { ...old.conversation.lead, status: 'tour_scheduled' }
                : old.conversation.lead,
              showings: [...(old.conversation.showings ?? []), data.showing],
            },
          };
        },
      );
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['showings'] });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      apiFetch(`/chat/conversations/${id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setInternalNote('');
      setActivityCategory('staff');
    },
  });

  const handoffMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch(`/chat/conversations/${id}/handoff`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      setHandoffReason('');
      setActivityCategory('staff');
    },
  });

  const updateShowingStatus = (showingId: string, status: ShowingSummary['status']) => {
    queryClient.setQueryData<{ conversation: Conversation }>(
      ['conversation', selectedId],
      (old) => {
        if (!old) return old;
        return {
          conversation: {
            ...old.conversation,
            showings: (old.conversation.showings ?? []).map((showing) =>
              showing.id === showingId ? { ...showing, status } : showing,
            ),
          },
        };
      },
    );
    queryClient.invalidateQueries({ queryKey: ['showings'] });
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const stageReplySuggestion = (suggestion: string) => {
    const staged = stageSuggestedReply(reply, suggestion);
    setReply(staged.reply);
    setPendingSuggestedReply(staged.pendingSuggestion);
  };

  const stageShowingReschedule = (showing: ShowingSummary) => {
    const nextSlot = new Date(showing.scheduledAt);
    nextSlot.setDate(nextSlot.getDate() + 1);
    setShowingDateTime(toDateTimeLocalValue(nextSlot));
    setShowingDuration(showing.durationMinutes);
  };

  const confirmShowingMutation = useMutation({
    mutationFn: (showing: ShowingSummary) =>
      apiFetch(`/showings/${showing.id}/confirm`, { method: 'POST' }),
    onSuccess: (_data, showing) => {
      updateShowingStatus(showing.id, 'confirmed');
      stageReplySuggestion(
        buildShowingSuggestedReply({
          action: 'confirmed',
          scheduledAt: showing.scheduledAt,
          propertyName:
            showing.unit?.property.name ?? selected?.unit?.property.name ?? 'the property',
          unitName: showing.unit?.name ?? selected?.unit?.name ?? '',
        }),
      );
    },
  });

  const cancelShowingMutation = useMutation({
    mutationFn: (showing: ShowingSummary) =>
      apiFetch(`/showings/${showing.id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_data, showing) => {
      updateShowingStatus(showing.id, 'cancelled');
      stageReplySuggestion(
        buildShowingSuggestedReply({
          action: 'cancelled',
          scheduledAt: showing.scheduledAt,
          propertyName:
            showing.unit?.property.name ?? selected?.unit?.property.name ?? 'the property',
          unitName: showing.unit?.name ?? selected?.unit?.name ?? '',
        }),
      );
    },
  });

  const conversations = data?.conversations ?? [];
  const selected = detail?.conversation;
  const units = unitsData?.units ?? [];
  const timelineItems = selected
    ? buildConversationTimeline({
        hasLead: Boolean(selected.lead),
        hasRecommendedUnit: Boolean(selected.unit),
        showingStatuses: (selected.showings ?? []).map((showing) => showing.status),
        hasPendingSuggestedReply: Boolean(pendingSuggestedReply),
      })
    : [];
  const activityItems = selected
    ? buildConversationActivity({
        lead: selected.lead
          ? { status: selected.lead.status, createdAt: selected.lead.createdAt }
          : null,
        recommendedUnit: selected.unit
          ? {
              unitName: selected.unit.name,
              propertyName: selected.unit.property.name,
              updatedAt: slotUpdatedAt(selected.slots, 'recommended_unit_id') ?? selected.updatedAt,
            }
          : null,
        slots: selected.slots,
        messages: selected.messages,
        showings: selected.showings ?? [],
        events: (selected.events ?? []).map(toConversationActivityEvent),
      })
    : [];
  const recentActivityItems = activityItems.slice(0, 5);
  const historyActivityItems = filterConversationActivity(activityItems, activityCategory);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Conversations</h1>
        <p className="text-sm text-slate-500">
          Bot chat history with prospects. Staff can step in manually when needed.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <h2 className="font-medium text-sm">{conversations.length} conversations</h2>
          </div>
          <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
            {isLoading && <p className="p-4 text-sm text-slate-400">Loading...</p>}
            {conversations.length === 0 && (
              <p className="p-4 text-sm text-slate-400">No conversations yet.</p>
            )}
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full text-left p-3 hover:bg-slate-50 ${selectedId === c.id ? 'bg-violet-50' : ''}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs ${CHANNEL_STYLES[c.channel] ?? 'bg-slate-100'}`}
                  >
                    {c.channel}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(c.updatedAt).toLocaleDateString('en-CA')}
                  </span>
                </div>
                <div className="text-sm font-medium">
                  {c.lead?.name ?? c.lead?.phone ?? c.externalId}
                </div>
                <div className="text-xs text-slate-400">{STATE_LABELS[c.state] ?? c.state}</div>
                {c.unit && (
                  <div className="mt-1 text-xs text-slate-500">
                    {c.unit.property.name} {c.unit.name}
                  </div>
                )}
                {visibleSlots(c.slots).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {visibleSlots(c.slots)
                      .slice(0, 3)
                      .map((slot) => (
                        <span
                          key={`${c.id}-${slot.key}`}
                          className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-500"
                        >
                          {SLOT_LABELS[slot.key] ?? slot.key}: {slot.value}
                        </span>
                      ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        <div
          className="lg:col-span-2 bg-white rounded-lg border border-slate-200 overflow-hidden flex flex-col"
          style={{ minHeight: '600px' }}
        >
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              Select a conversation to view the history
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs ${CHANNEL_STYLES[selected.channel] ?? 'bg-slate-100'}`}
                  >
                    {selected.channel}
                  </span>
                  <span className="ml-2 text-sm font-medium">
                    {selected.lead?.name ?? selected.externalId}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {selected.lead && (
                    <select
                      aria-label="Lead status"
                      value={selected.lead.status}
                      onChange={(event) =>
                        leadStatusMutation.mutate({
                          id: selected.lead!.id,
                          status: event.target.value as LeadStatus,
                        })
                      }
                      disabled={leadStatusMutation.isPending}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
                    >
                      {LEAD_STATUS_OPTIONS.map((status) => (
                        <option key={status.value} value={status.value}>
                          {status.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="text-xs text-slate-400">
                    {STATE_LABELS[selected.state] ?? selected.state}
                  </span>
                </div>
              </div>

              <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
                <div className="text-[11px] font-medium uppercase text-slate-400">
                  Conversation timeline
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {timelineItems.map((item) => (
                    <span
                      key={item.key}
                      className={`rounded-md border px-2 py-1 text-xs font-medium ${TIMELINE_TONE_STYLES[item.tone]}`}
                    >
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="border-b border-slate-100 bg-white px-4 py-3">
                {selected.unit ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-medium uppercase text-slate-400">
                        Recommended unit
                      </div>
                      <div className="text-sm font-medium text-slate-800">
                        {selected.unit.property.name} {selected.unit.name} /{' '}
                        {selected.unit.property.city}
                      </div>
                    </div>
                    <div className="rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700">
                      ${(selected.unit.rentCents / 100).toLocaleString('en-CA')}/month
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="text-[11px] font-medium uppercase text-slate-400">
                      Recommended unit
                    </div>
                    <div className="text-sm font-medium text-slate-700">No unit selected yet</div>
                  </div>
                )}
                {slotValue(selected.slots, 'match_reason') && (
                  <p className="mt-2 text-xs text-slate-500">
                    {slotValue(selected.slots, 'match_reason')}
                  </p>
                )}
                <div className="mt-3 flex flex-col gap-1 sm:max-w-md">
                  <label
                    htmlFor="recommended-unit"
                    className="text-[11px] font-medium uppercase text-slate-400"
                  >
                    Staff override
                  </label>
                  <select
                    id="recommended-unit"
                    value={selected.unit?.id ?? ''}
                    onChange={(event) => {
                      if (event.target.value) {
                        recommendedUnitMutation.mutate({
                          id: selected.id,
                          unitId: event.target.value,
                        });
                      }
                    }}
                    disabled={recommendedUnitMutation.isPending || units.length === 0}
                    className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
                  >
                    <option value="">Select an active unit</option>
                    {units.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.property.name} {unit.name} / {unit.property.city} - $
                        {(unit.rentCents / 100).toLocaleString('en-CA')}/month
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {visibleSlots(selected.slots).length > 0 && (
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                    {[
                      {
                        key: 'budget',
                        value: slotValue(selected.slots, 'budget')
                          ? `$${slotValue(selected.slots, 'budget')}`
                          : undefined,
                      },
                      { key: 'move_in_date', value: slotValue(selected.slots, 'move_in_date') },
                      { key: 'preferred_area', value: slotValue(selected.slots, 'preferred_area') },
                      { key: 'occupants', value: slotValue(selected.slots, 'occupants') },
                      { key: 'pets', value: slotValue(selected.slots, 'pets') },
                    ].map(({ key, value }) => (
                      <div
                        key={key}
                        className="min-h-[54px] rounded-md border border-slate-200 bg-white px-2 py-1.5"
                      >
                        <div className="text-[11px] font-medium uppercase text-slate-400">
                          {SLOT_LABELS[key] ?? key}
                        </div>
                        <div className="mt-0.5 truncate text-sm font-medium text-slate-700">
                          {value ?? '-'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {recentActivityItems.length > 0 && (
                <div className="border-b border-slate-100 bg-white px-4 py-3">
                  <div className="text-[11px] font-medium uppercase text-slate-400">
                    Recent activity
                  </div>
                  <div className="mt-2 space-y-2">
                    {recentActivityItems.map((item) => (
                      <div key={item.key} className="grid grid-cols-[12px_1fr_auto] gap-2 text-xs">
                        <span
                          className={`mt-1 h-2.5 w-2.5 rounded-full ${ACTIVITY_TONE_STYLES[item.tone]}`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-slate-700">{item.label}</div>
                          <div className="truncate text-slate-500">
                            {item.actorName ? `${item.actorName}: ${item.detail}` : item.detail}
                          </div>
                        </div>
                        <time className="whitespace-nowrap text-slate-400">
                          {formatActivityTime(item.occurredAt)}
                        </time>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activityItems.length > 0 && (
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] font-medium uppercase text-slate-400">
                      Activity history
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {ACTIVITY_FILTER_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setActivityCategory(option.value)}
                          className={`rounded-md border px-2 py-1 text-xs font-medium ${
                            activityCategory === option.value
                              ? 'border-violet-200 bg-violet-50 text-violet-700'
                              : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                    {historyActivityItems.length === 0 ? (
                      <p className="text-xs text-slate-400">No activity in this category yet.</p>
                    ) : (
                      historyActivityItems.map((item) => (
                        <div
                          key={`history-${item.key}`}
                          className="grid grid-cols-[12px_minmax(0,1fr)_auto] gap-2 border-b border-slate-100 pb-2 text-xs last:border-b-0 last:pb-0"
                        >
                          <span
                            className={`mt-1 h-2.5 w-2.5 rounded-full ${ACTIVITY_TONE_STYLES[item.tone]}`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="font-medium text-slate-700">{item.label}</span>
                              <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                                {
                                  ACTIVITY_FILTER_OPTIONS.find(
                                    (option) => option.value === item.category,
                                  )?.label
                                }
                              </span>
                            </div>
                            <div className="mt-0.5 text-slate-500">
                              {item.actorName ? `${item.actorName}: ${item.detail}` : item.detail}
                            </div>
                          </div>
                          <time className="whitespace-nowrap text-slate-400">
                            {formatActivityTime(item.occurredAt)}
                          </time>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              <div className="border-b border-slate-100 bg-white px-4 py-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor="internal-note"
                      className="text-[11px] font-medium uppercase text-slate-400"
                    >
                      Internal note
                    </label>
                    <textarea
                      id="internal-note"
                      value={internalNote}
                      onChange={(event) => setInternalNote(event.target.value)}
                      rows={3}
                      placeholder="Add staff-only context..."
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        internalNote.trim() &&
                        addNoteMutation.mutate({ id: selected.id, note: internalNote.trim() })
                      }
                      disabled={!internalNote.trim() || addNoteMutation.isPending}
                      className="mt-2 inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      <Icon name="document" size={14} />
                      Add note
                    </button>
                  </div>
                  <div>
                    <label
                      htmlFor="handoff-reason"
                      className="text-[11px] font-medium uppercase text-slate-400"
                    >
                      Human handoff
                    </label>
                    <textarea
                      id="handoff-reason"
                      value={handoffReason}
                      onChange={(event) => setHandoffReason(event.target.value)}
                      rows={3}
                      placeholder="Reason for staff follow-up..."
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        handoffMutation.mutate({
                          id: selected.id,
                          reason: handoffReason.trim() || undefined,
                        })
                      }
                      disabled={handoffMutation.isPending}
                      className="mt-2 inline-flex items-center gap-1 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      <Icon name="hitl" size={14} />
                      Request handoff
                    </button>
                  </div>
                </div>
              </div>

              <div className="border-b border-slate-100 bg-white px-4 py-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[190px] flex-1">
                    <label
                      htmlFor="showing-date"
                      className="text-[11px] font-medium uppercase text-slate-400"
                    >
                      Schedule tour
                    </label>
                    <input
                      id="showing-date"
                      type="datetime-local"
                      value={showingDateTime}
                      onChange={(event) => setShowingDateTime(event.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="showing-duration"
                      className="text-[11px] font-medium uppercase text-slate-400"
                    >
                      Duration
                    </label>
                    <select
                      id="showing-duration"
                      value={showingDuration}
                      onChange={(event) => setShowingDuration(Number(event.target.value))}
                      className="mt-1 w-28 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                    >
                      {[15, 30, 45, 60].map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} min
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={() =>
                      scheduleShowingMutation.mutate({
                        id: selected.id,
                        scheduledAt: showingDateTime,
                        durationMinutes: showingDuration,
                      })
                    }
                    disabled={
                      !selected.lead ||
                      !selected.unit ||
                      !showingDateTime ||
                      scheduleShowingMutation.isPending
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    <Icon name="showings" size={14} />
                    Create showing
                  </button>
                </div>
                {(!selected.lead || !selected.unit) && (
                  <p className="mt-2 text-xs text-slate-400">
                    A linked lead and recommended unit are required.
                  </p>
                )}
                {(selected.showings ?? []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.showings!.map((showing) => (
                      <div
                        key={showing.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-teal-100 bg-teal-50 px-2 py-1 text-xs text-teal-800"
                      >
                        <div>
                          <span className="font-medium">
                            {formatShowingDateTime(showing.scheduledAt)}
                          </span>
                          <span className="text-teal-600">
                            {' '}
                            / {showing.durationMinutes} min / {showing.status}
                          </span>
                        </div>
                        {canConfirmShowing(showing.status) && (
                          <button
                            onClick={() => confirmShowingMutation.mutate(showing)}
                            disabled={
                              confirmShowingMutation.isPending || cancelShowingMutation.isPending
                            }
                            className="rounded border border-green-200 bg-white px-1.5 py-0.5 font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                          >
                            Confirm
                          </button>
                        )}
                        {canCancelShowing(showing.status) && (
                          <button
                            onClick={() => cancelShowingMutation.mutate(showing)}
                            disabled={
                              confirmShowingMutation.isPending || cancelShowingMutation.isPending
                            }
                            className="rounded border border-red-200 bg-white px-1.5 py-0.5 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        )}
                        {canRescheduleShowing(showing.status) && (
                          <button
                            onClick={() => stageShowingReschedule(showing)}
                            className="rounded border border-teal-200 bg-white px-1.5 py-0.5 font-medium text-teal-700 hover:bg-teal-50"
                          >
                            Reschedule
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2 max-h-[400px]">
                {selected.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === 'user' ? 'justify-start' : 'justify-end'}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                        msg.role === 'user'
                          ? 'bg-slate-100 text-slate-700 rounded-bl-md'
                          : msg.role === 'staff'
                            ? 'bg-blue-600 text-white rounded-br-md'
                            : 'bg-violet-600 text-white rounded-br-md'
                      }`}
                    >
                      {msg.role === 'staff' && (
                        <div className="text-[10px] opacity-75 mb-0.5">Staff</div>
                      )}
                      {msg.role === 'assistant' && (
                        <div className="text-[10px] opacity-75 mb-0.5">Bot</div>
                      )}
                      {msg.content}
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-3 border-t border-slate-200 flex gap-2">
                <div className="flex-1">
                  {pendingSuggestedReply && (
                    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <span className="font-medium">Suggested reply ready</span>
                      <span className="min-w-0 flex-1 truncate text-amber-700">
                        {pendingSuggestedReply}
                      </span>
                      <button
                        onClick={() => {
                          setReply(pendingSuggestedReply);
                          setPendingSuggestedReply(null);
                        }}
                        className="rounded border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
                      >
                        Use
                      </button>
                      <button
                        onClick={() => setPendingSuggestedReply(null)}
                        className="rounded border border-slate-200 bg-white px-2 py-0.5 font-medium text-slate-600 hover:bg-slate-50"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  <input
                    type="text"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && reply.trim()) {
                        replyMutation.mutate({ id: selected.id, message: reply.trim() });
                      }
                    }}
                    placeholder="Write a manual reply..."
                    className="w-full rounded-full border border-slate-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
                <button
                  onClick={() =>
                    reply.trim() && replyMutation.mutate({ id: selected.id, message: reply.trim() })
                  }
                  disabled={!reply.trim() || replyMutation.isPending}
                  className="inline-flex h-[38px] items-center gap-1 rounded-full bg-violet-600 px-4 py-2 text-white text-sm hover:bg-violet-700 disabled:opacity-50"
                >
                  <Icon name="upload" size={14} className="rotate-90" />
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

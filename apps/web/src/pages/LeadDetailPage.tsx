import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import type { LeadDetail, StaffUser } from '../lib/types';

const STATUS_LABELS: Record<string, string> = {
  new_: 'New',
  contacted: 'Contacted',
  tour_scheduled: 'Tour scheduled',
  qualified: 'Qualified',
  converted: 'Converted',
  lost: 'Lost',
};

const OPERATIONAL_STATUS_OPTIONS = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'waiting_on_prospect', label: 'Waiting on prospect' },
  { value: 'needs_handoff', label: 'Needs handoff' },
  { value: 'closed', label: 'Closed' },
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function profileRows(lead: LeadDetail): Array<{ label: string; value: string | undefined | null }> {
  const profile = lead.prospectProfile;
  return [
    { label: 'Budget', value: profile?.budget ? `$${profile.budget}` : null },
    { label: 'Move-in', value: profile?.moveInDate },
    { label: 'Area', value: profile?.preferredArea },
    { label: 'Occupants', value: profile?.occupants },
    { label: 'Pets', value: profile?.pets },
    { label: 'Last channel', value: profile?.lastChannel },
    { label: 'Conversation state', value: profile?.conversationState },
  ];
}

export function LeadDetailPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [workflowDraft, setWorkflowDraft] = useState<{
    operationalStatus: string;
    assignedUserId: string;
  } | null>(null);
  const { data, isLoading } = useQuery<{ lead: LeadDetail }>({
    queryKey: ['lead', id],
    queryFn: () => apiFetch(`/leads/${id}`),
    enabled: Boolean(id),
  });
  const { data: usersData } = useQuery<{ users: StaffUser[] }>({
    queryKey: ['staff-users'],
    queryFn: () => apiFetch('/users/staff'),
  });

  const workflowMutation = useMutation({
    mutationFn: (payload: { operationalStatus: string; assignedUserId: string | null }) =>
      apiFetch(`/leads/${id}/workflow`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', id] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });

  const lead = data?.lead;
  const users = usersData?.users ?? [];
  const workflow = workflowDraft ?? {
    operationalStatus: lead?.operationalStatus ?? 'needs_review',
    assignedUserId: lead?.assignedUserId ?? '',
  };

  if (isLoading) {
    return <p className="text-sm text-slate-400">Loading lead...</p>;
  }

  if (!lead) {
    return (
      <div className="space-y-3">
        <Link to="/leads" className="text-sm font-medium text-brand-700 hover:text-brand-800">
          Back to leads
        </Link>
        <p className="text-sm text-slate-500">Lead not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/leads" className="text-sm font-medium text-brand-700 hover:text-brand-800">
            Back to leads
          </Link>
          <h1 className="mt-2 text-2xl font-bold">{lead.name ?? 'Anonymous prospect'}</h1>
          <p className="text-sm text-slate-500">
            {lead.source} lead / {STATUS_LABELS[lead.status] ?? lead.status}
          </p>
        </div>
        {lead.latestActivity && (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
            <div className="text-xs font-medium uppercase text-slate-400">Latest activity</div>
            <div className="mt-1 font-medium text-slate-800">{lead.latestActivity.label}</div>
            <div className="text-slate-500">{lead.latestActivity.detail}</div>
          </div>
        )}
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label>
            <span className="mb-1 block text-xs font-medium text-slate-500">Operational status</span>
            <select
              value={workflow.operationalStatus}
              onChange={(event) =>
                setWorkflowDraft({ ...workflow, operationalStatus: event.target.value })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {OPERATIONAL_STATUS_OPTIONS.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-slate-500">Assigned to</span>
            <select
              value={workflow.assignedUserId}
              onChange={(event) =>
                setWorkflowDraft({ ...workflow, assignedUserId: event.target.value })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Unassigned</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.firstName} {user.lastName} / {user.role.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              workflowMutation.mutate({
                operationalStatus: workflow.operationalStatus,
                assignedUserId: workflow.assignedUserId || null,
              })
            }
            disabled={workflowMutation.isPending}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Save workflow
          </button>
        </div>
        {lead.assignedUser && (
          <p className="mt-2 text-xs text-slate-500">
            Current owner: {lead.assignedUser.firstName} {lead.assignedUser.lastName}
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="font-medium">Profile</h2>
          <div className="mt-3 space-y-2 text-sm">
            <InfoRow label="Phone" value={lead.phone} />
            <InfoRow label="Email" value={lead.email} />
            <InfoRow label="Preferred channel" value={lead.preferredChannel} />
            <InfoRow
              label="Unit"
              value={
                lead.unit
                  ? `${lead.unit.property.name} ${lead.unit.name}, ${lead.unit.property.city}`
                  : null
              }
            />
            {profileRows(lead).map((row) => (
              <InfoRow key={row.label} label={row.label} value={row.value} />
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 lg:col-span-2">
          <h2 className="font-medium">Activity history</h2>
          <div className="mt-3 max-h-[340px] space-y-3 overflow-y-auto pr-1">
            {lead.conversationEvents.length === 0 && (
              <p className="text-sm text-slate-400">No activity has been recorded yet.</p>
            )}
            {lead.conversationEvents.map((event) => (
              <div key={event.id} className="border-b border-slate-100 pb-3 last:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-sm text-slate-800">{event.label}</div>
                  <time className="text-xs text-slate-400">{formatDateTime(event.createdAt)}</time>
                </div>
                <div className="mt-1 text-sm text-slate-500">{event.detail}</div>
                {event.actorUser && (
                  <div className="mt-1 text-xs text-slate-400">
                    {event.actorUser.firstName} {event.actorUser.lastName}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="font-medium">Conversations</h2>
          <div className="mt-3 space-y-3">
            {lead.conversations.length === 0 && (
              <p className="text-sm text-slate-400">No conversations yet.</p>
            )}
            {lead.conversations.map((conversation) => (
              <div key={conversation.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium capitalize">{conversation.channel}</span>
                  <span className="text-xs text-slate-400">
                    {formatDateTime(conversation.updatedAt)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">{conversation.state}</div>
                <div className="mt-2 space-y-1">
                  {conversation.messages.map((message) => (
                    <div key={message.id} className="truncate text-xs text-slate-500">
                      <span className="font-medium text-slate-600">{message.role}:</span>{' '}
                      {message.content}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="font-medium">Showings & Notes</h2>
          <div className="mt-3 space-y-3">
            {lead.showings.map((showing) => (
              <div key={showing.id} className="rounded-md border border-teal-100 bg-teal-50 p-3 text-sm">
                <div className="font-medium text-teal-900">{formatDateTime(showing.scheduledAt)}</div>
                <div className="text-xs text-teal-700">
                  {showing.durationMinutes} min / {showing.status}
                  {showing.unit ? ` / ${showing.unit.property.name} ${showing.unit.name}` : ''}
                </div>
              </div>
            ))}
            {lead.notes.map((note) => (
              <div key={note.id} className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                <div className="text-xs font-medium uppercase text-slate-400">Internal note</div>
                <div className="mt-1 text-slate-700">{note.detail}</div>
                <time className="mt-1 block text-xs text-slate-400">{formatDateTime(note.createdAt)}</time>
              </div>
            ))}
            {lead.showings.length === 0 && lead.notes.length === 0 && (
              <p className="text-sm text-slate-400">No showings or notes yet.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | undefined | null }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 pb-2 last:border-b-0">
      <span className="text-slate-400">{label}</span>
      <span className="text-right font-medium text-slate-700">{value || '-'}</span>
    </div>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { Icon, IconBadge } from '../components/Icon';

interface Showing {
  id: string;
  showmojoId: string | null;
  scheduledAt: string;
  durationMinutes: number;
  brokerUserId: string | null;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  showmojoUrl: string | null;
  lead: { name: string | null; phone: string | null; email: string | null };
  unit: { name: string; property: { name: string; address: string; city: string } } | null;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  scheduled: { label: 'Pending confirmation', color: 'bg-amber-100 text-amber-800' },
  confirmed: { label: 'Confirmed', color: 'bg-green-100 text-green-800' },
  completed: { label: 'Completed', color: 'bg-blue-100 text-blue-800' },
  cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  no_show: { label: 'No-show', color: 'bg-slate-100 text-slate-600' },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Agrupa showings por día para la vista de calendario. */
function groupByDay(showings: Showing[]): Array<{ date: string; label: string; showings: Showing[] }> {
  const groups = new Map<string, Showing[]>();
  for (const s of showings) {
    const dayKey = new Date(s.scheduledAt).toDateString();
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey)!.push(s);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .map(([dateKey, items]) => ({
      date: dateKey,
      label: formatDate(items[0]!.scheduledAt),
      showings: items.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()),
    }));
}

export function ShowingsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>('');

  const { data, isLoading } = useQuery<{ showings: Showing[] }>({
    queryKey: ['showings', filter],
    queryFn: () => apiFetch(`/showings${filter ? `?status=${filter}` : ''}`),
  });

  const confirmMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/showings/${id}/confirm`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['showings'] }),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/showings/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['showings'] }),
  });

  const showings = data?.showings ?? [];
  const days = groupByDay(showings);
  const pendingCount = showings.filter((s) => s.status === 'scheduled').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Icon name="showings" size={24} className="text-teal-600" />
            Showings & Calendar
          </h1>
          <p className="text-sm text-slate-500">
            Property tours booked by prospects. Confirm your availability as broker/PM.
          </p>
        </div>
        <div className="flex gap-3">
          <div className="rounded-lg bg-white border border-slate-200 px-4 py-2 text-center">
            <div className="text-2xl font-bold text-slate-900">{showings.length}</div>
            <div className="text-xs text-slate-500">Total</div>
          </div>
          <div className="rounded-lg bg-white border border-slate-200 px-4 py-2 text-center">
            <div className="text-2xl font-bold text-amber-600">{pendingCount}</div>
            <div className="text-xs text-slate-500">Pending</div>
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div className="mb-6 flex gap-2 text-sm">
        {['', 'scheduled', 'confirmed', 'completed', 'cancelled'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            {f === '' ? 'Todas' : STATUS_META[f]?.label ?? f}
          </button>
        ))}
      </div>

      {/* Calendario / Lista por día */}
      {isLoading ? (
        <p className="text-slate-400">Cargando visitas...</p>
      ) : days.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-12 text-center">
          <IconBadge name="showings" badgeSize={48} />
          <p className="text-slate-400 mt-3">Sin visitas agendadas. Los prospectos que conversen con el bot y agenden aparecerán aquí.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <div key={day.date}>
              {/* Header del día */}
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-50 text-teal-700 flex-col">
                  <span className="text-xs font-medium uppercase">
                    {new Date(day.date).toLocaleDateString('en-CA', { month: 'short' })}
                  </span>
                  <span className="text-lg font-bold leading-none">
                    {new Date(day.date).getDate()}
                  </span>
                </div>
                <h2 className="text-sm font-medium text-slate-700">{day.label}</h2>
                <span className="text-xs text-slate-400">({day.showings.length} {day.showings.length === 1 ? 'visita' : 'visitas'})</span>
              </div>

              {/* Cards de visitas del día */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pl-15">
                {day.showings.map((showing) => {
                  const meta = STATUS_META[showing.status] ?? STATUS_META.scheduled;
                  return (
                    <div key={showing.id} className="bg-white rounded-lg border border-slate-200 p-4 hover:shadow-sm transition">
                      {/* Hora y estado */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Icon name="schedule" size={16} className="text-slate-400" />
                          <span className="text-sm font-medium">{formatTime(showing.scheduledAt)}</span>
                          <span className="text-xs text-slate-400">({showing.durationMinutes} min)</span>
                        </div>
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${meta.color}`}>
                          {meta.label}
                        </span>
                      </div>

                      {/* Prospecto */}
                      <div className="mb-2">
                        <div className="font-medium text-slate-900">
                          {showing.lead.name ?? showing.lead.phone ?? 'Prospecto'}
                        </div>
                        {showing.lead.phone && (
                          <div className="text-xs text-slate-500">{showing.lead.phone}</div>
                        )}
                        {showing.lead.email && (
                          <div className="text-xs text-slate-500">{showing.lead.email}</div>
                        )}
                      </div>

                      {/* Unidad */}
                      {showing.unit && (
                        <div className="text-xs text-slate-500 mb-3">
                          {showing.unit.name} · {showing.unit.property.name}
                          <div>{showing.unit.property.address}, {showing.unit.property.city}</div>
                        </div>
                      )}

                      {/* Link de ShowMojo */}
                      {showing.showmojoUrl && (
                        <a
                          href={showing.showmojoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-teal-600 hover:underline mb-3"
                        >
                          <Icon name="document" size={12} />
                          Ver en ShowMojo
                        </a>
                      )}

                      {/* Acciones */}
                      {showing.status === 'scheduled' && (
                        <div className="flex gap-2 pt-2 border-t border-slate-100">
                          <button
                            onClick={() => confirmMutation.mutate(showing.id)}
                            disabled={confirmMutation.isPending}
                            className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100"
                          >
                            <Icon name="approve" size={14} />
                            Confirm
                          </button>
                          <button
                            onClick={() => cancelMutation.mutate(showing.id)}
                            disabled={cancelMutation.isPending}
                            className="inline-flex items-center justify-center gap-1 rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                          >
                            <Icon name="reject" size={14} />
                            Cancel
                          </button>
                        </div>
                      )}
                      {showing.status === 'confirmed' && (
                        <div className="pt-2 border-t border-slate-100">
                          <div className="flex items-center gap-1.5 text-xs text-green-600 mb-2">
                            <Icon name="approve" size={14} />
                            Visit confirmed
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => cancelMutation.mutate(showing.id)}
                              disabled={cancelMutation.isPending}
                              className="inline-flex items-center justify-center gap-1 rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                            >
                              <Icon name="reject" size={14} />
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

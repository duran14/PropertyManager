import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../lib/apiClient';
import { useAuth } from '../auth/AuthContext';
import { Icon, IconBadge } from '../components/Icon';
import { CalendarSettingsCard } from '../components/CalendarSettingsCard';

interface Showing {
  id: string;
  showmojoId: string | null;
  scheduledAt: string;
  durationMinutes: number;
  brokerUserId: string | null;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  showmojoUrl: string | null;
  // Fase 1.3: si sigue nulo en 'scheduled', el auto-booking no logró crear
  // el evento en Google Calendar (o el showing es previo a la conexión).
  googleEventId?: string | null;
  lead: { name: string | null; phone: string | null; email: string | null };
  unit: { name: string; property: { name: string; address: string; city: string } } | null;
}

interface CompleteShowingResponse {
  status: string;
  applicationId: string;
  applicationUrl: string;
  linkDelivered: boolean;
}

interface ApplicationDetail {
  id: string;
  status: string;
  annualIncome: number | null;
  employerName: string | null;
  references: string | null;
  applicantFullName: string | null;
  idDocumentStorageKey: string | null;
  consentApplicationAt: string | null;
  consentCreditCheckAt: string | null;
  consentPoliceCheckAt: string | null;
  submittedAt: string | null;
  createdAt: string;
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

function groupByDay(showings: Showing[]): Array<{ date: string; label: string; showings: Showing[] }> {
  const groups = new Map<string, Showing[]>();
  for (const showing of showings) {
    const dayKey = new Date(showing.scheduledAt).toDateString();
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey)!.push(showing);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .map(([dateKey, items]) => ({
      date: dateKey,
      label: formatDate(items[0]!.scheduledAt),
      showings: items.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()),
    }));
}

function ConsentRow({ label, at }: { label: string; at: string | null }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className={at ? 'text-green-700' : 'text-slate-400'}>
        {at ? new Date(at).toLocaleString('en-CA') : 'Not given'}
      </span>
    </div>
  );
}

/**
 * Panel de la aplicación de renta para un showing completado. Se monta como
 * su propio componente (en vez de llamar useQuery dentro del .map de
 * ShowingsPage) para no violar las reglas de hooks cuando la lista de
 * showings cambia de tamaño entre renders.
 */
function CompletedApplicationPanel({ showingId }: { showingId: string }) {
  const { data, isLoading, isError, error } = useQuery<{ application: ApplicationDetail }>({
    queryKey: ['showing-application', showingId],
    queryFn: () => apiFetch(`/showings/${showingId}/application`),
    retry: false,
  });

  if (isLoading) {
    return <p className="pt-2 border-t border-slate-100 text-xs text-slate-400">Loading application…</p>;
  }

  if (isError) {
    if (error instanceof ApiError && error.status === 404) {
      return <p className="pt-2 border-t border-slate-100 text-xs text-slate-400">Application not submitted yet.</p>;
    }
    return <p className="pt-2 border-t border-slate-100 text-xs text-red-600">Could not load the application.</p>;
  }

  const app = data?.application;
  // El endpoint devuelve 200 con la fila desde que se completa el showing
  // (se crea en estado 'invited' junto con el link), mucho antes de que el
  // prospecto la llene. Sin este chequeo de `status`, la tarjeta mostraría
  // "Applicant" y una lista de "Not provided" como si hubiera datos reales.
  if (!app || app.status !== 'submitted') {
    return <p className="pt-2 border-t border-slate-100 text-xs text-slate-400">Application not submitted yet.</p>;
  }

  return (
    <div className="pt-2 border-t border-slate-100 text-xs text-slate-600 space-y-1.5">
      <div className="flex items-center gap-1.5 font-medium text-slate-800">
        <Icon name="document" size={14} />
        {app.applicantFullName ?? 'Applicant'}
      </div>
      <div>Annual income: {app.annualIncome != null ? `$${app.annualIncome.toLocaleString('en-CA')}` : 'Not provided'}</div>
      <div>Employer: {app.employerName ?? 'Not provided'}</div>
      <div>References: {app.references ?? 'Not provided'}</div>
      {app.idDocumentStorageKey && (
        // Hay un documento de identificación guardado, pero no existe
        // ninguna ruta en la app que sirva archivos de DOCUMENT_STORAGE_DIR
        // — servir/descargar el documento queda fuera de alcance de este
        // fix y es trabajo futuro.
        <div className="flex items-center gap-1 text-slate-500">
          <Icon name="approve" size={12} className="text-green-600" />
          ID document attached
        </div>
      )}
      <div className="mt-1.5 space-y-0.5 rounded-md bg-slate-50 p-2">
        <ConsentRow label="Application consent" at={app.consentApplicationAt} />
        <ConsentRow label="Credit check consent" at={app.consentCreditCheckAt} />
        <ConsentRow label="Police check consent" at={app.consentPoliceCheckAt} />
      </div>
    </div>
  );
}

export function ShowingsPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<string>('');
  // Resultado (o error) de la última llamada a "Mark as completed" por
  // showing, para mostrarlo en la tarjeta — el backend solo lo devuelve una
  // vez, en la respuesta de esta mutación (ver GET /:id/application, que
  // sí persiste, para el Fix 5).
  const [completionResults, setCompletionResults] = useState<Record<string, CompleteShowingResponse>>({});
  const [completionErrors, setCompletionErrors] = useState<Record<string, string>>({});
  const [copiedShowingId, setCopiedShowingId] = useState<string | null>(null);

  // El callback de OAuth de Google redirige aquí con ?calendar=connected|error
  // (ver apps/api/src/routes/integrations.google-calendar.ts). Se captura una
  // sola vez al montar y se limpia el parámetro para que no reaparezca al
  // recargar la página.
  const [calendarNotice, setCalendarNotice] = useState<{ status: 'connected' | 'error'; reason: string | null } | null>(null);
  useEffect(() => {
    const status = searchParams.get('calendar');
    if (status === 'connected' || status === 'error') {
      setCalendarNotice({ status, reason: searchParams.get('reason') });
      const next = new URLSearchParams(searchParams);
      next.delete('calendar');
      next.delete('reason');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const completeMutation = useMutation({
    mutationFn: (id: string) => apiFetch<CompleteShowingResponse>(`/showings/${id}/complete`, { method: 'POST' }),
    onSuccess: (result, id) => {
      setCompletionResults((prev) => ({ ...prev, [id]: result }));
      setCompletionErrors((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ['showings'] });
    },
    onError: (err, id) => {
      setCompletionErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Could not complete the showing',
      }));
    },
  });

  async function handleCopyApplicationUrl(showingId: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedShowingId(showingId);
      window.setTimeout(() => setCopiedShowingId((current) => (current === showingId ? null : current)), 2000);
    } catch {
      // El acceso al portapapeles puede estar bloqueado (permisos del
      // navegador); el link sigue visible y seleccionable a mano en la
      // tarjeta, así que no hace falta un error visible aquí.
    }
  }

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
            Property tours booked by prospects. Confirm broker or PM availability.
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

      {calendarNotice && (
        <div
          role="alert"
          className={`mb-4 rounded-md border p-3 text-sm ${
            calendarNotice.status === 'connected'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {calendarNotice.status === 'connected'
            ? 'Google Calendar quedó conectado.'
            : `No se pudo conectar Google Calendar${calendarNotice.reason ? ` (${calendarNotice.reason})` : ''}.`}
        </div>
      )}

      <div className="mb-6">
        <CalendarSettingsCard canManage={user?.role === 'property_manager'} />
      </div>

      <div className="mb-6 flex gap-2 text-sm">
        {['', 'scheduled', 'confirmed', 'completed', 'cancelled'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            {f === '' ? 'All' : STATUS_META[f]?.label ?? f}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-slate-400">Loading showings...</p>
      ) : days.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-12 text-center">
          <IconBadge name="showings" badgeSize={48} />
          <p className="text-slate-400 mt-3">No showings scheduled yet. Tours booked by the bot will appear here.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <div key={day.date}>
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-50 text-teal-700 flex-col">
                  <span className="text-xs font-medium uppercase">
                    {new Date(day.date).toLocaleDateString('en-CA', { month: 'short' })}
                  </span>
                  <span className="text-lg font-bold leading-none">{new Date(day.date).getDate()}</span>
                </div>
                <h2 className="text-sm font-medium text-slate-700">{day.label}</h2>
                <span className="text-xs text-slate-400">
                  ({day.showings.length} {day.showings.length === 1 ? 'showing' : 'showings'})
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:pl-14">
                {day.showings.map((showing) => {
                  const meta = STATUS_META[showing.status] ?? STATUS_META.scheduled;
                  return (
                    <div key={showing.id} className="bg-white rounded-lg border border-slate-200 p-4 hover:shadow-sm transition">
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

                      {showing.status === 'scheduled' && !showing.googleEventId && (
                        // El auto-booking no logró crear el evento en Google Calendar (o el
                        // showing es previo a conectar el calendario): nadie lo va a ver como
                        // ocupado hasta que alguien lo bloquee a mano.
                        <div className="mb-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          <Icon name="warning" size={12} />
                          sin bloquear en calendario
                        </div>
                      )}

                      <div className="mb-2">
                        <div className="font-medium text-slate-900">
                          {showing.lead.name ?? showing.lead.phone ?? 'Prospect'}
                        </div>
                        {showing.lead.phone && <div className="text-xs text-slate-500">{showing.lead.phone}</div>}
                        {showing.lead.email && <div className="text-xs text-slate-500">{showing.lead.email}</div>}
                      </div>

                      {showing.unit && (
                        <div className="text-xs text-slate-500 mb-3">
                          {showing.unit.name} / {showing.unit.property.name}
                          <div>{showing.unit.property.address}, {showing.unit.property.city}</div>
                        </div>
                      )}

                      {showing.showmojoUrl && (
                        <a
                          href={showing.showmojoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-teal-600 hover:underline mb-3"
                        >
                          <Icon name="document" size={12} />
                          View in ShowMojo
                        </a>
                      )}

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
                          <button
                            onClick={() => cancelMutation.mutate(showing.id)}
                            disabled={cancelMutation.isPending}
                            className="inline-flex items-center justify-center gap-1 rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                          >
                            <Icon name="reject" size={14} />
                            Cancel
                          </button>
                          <button
                            onClick={() => completeMutation.mutate(showing.id)}
                            disabled={completeMutation.isPending}
                            className="inline-flex items-center justify-center gap-1 rounded-md bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
                          >
                            <Icon name="document" size={14} />
                            Mark as completed
                          </button>
                          {completionErrors[showing.id] && (
                            <p role="alert" className="mt-2 text-xs text-red-600">
                              {completionErrors[showing.id]}
                            </p>
                          )}
                        </div>
                      )}
                      {showing.status === 'completed' && (
                        <div className="pt-2 border-t border-slate-100 space-y-2">
                          {completionResults[showing.id] &&
                            (completionResults[showing.id]!.linkDelivered ? (
                              <div className="flex items-center gap-1.5 text-xs text-green-700">
                                <Icon name="approve" size={14} />
                                Application link sent to the prospect
                              </div>
                            ) : (
                              <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                                <div className="flex items-center gap-1.5 font-medium">
                                  <Icon name="warning" size={14} />
                                  Link could not be delivered automatically — copy and send it yourself
                                </div>
                                <p className="mt-1 select-all break-all rounded bg-white px-1.5 py-1 text-[11px] text-slate-700">
                                  {completionResults[showing.id]!.applicationUrl}
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleCopyApplicationUrl(showing.id, completionResults[showing.id]!.applicationUrl)
                                  }
                                  className="mt-1 rounded-md bg-amber-100 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-200"
                                >
                                  {copiedShowingId === showing.id ? 'Copied!' : 'Copy link'}
                                </button>
                              </div>
                            ))}
                          <CompletedApplicationPanel showingId={showing.id} />
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

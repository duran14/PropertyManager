import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import type { CalendarConnectionStatus, SchedulingConfig } from '../lib/types';

interface Props {
  /** Solo property_manager puede conectar, desconectar y guardar. */
  canManage: boolean;
}

type WeekdayKey = keyof SchedulingConfig['weeklyHours'];

const WEEKDAYS: Array<{ key: WeekdayKey; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const DURATION_OPTIONS = [15, 30, 45, 60];
const GRANULARITY_OPTIONS = [15, 30, 60];

export function CalendarSettingsCard({ canManage }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SchedulingConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const connection = useQuery<CalendarConnectionStatus>({
    queryKey: ['calendar-connection'],
    queryFn: () => apiFetch('/integrations/google-calendar'),
  });

  const authorize = useMutation({
    mutationFn: () => apiFetch<{ authorizeUrl: string }>(
      '/integrations/google-calendar/authorize',
      { method: 'POST' },
    ),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
  });

  const disconnect = useMutation({
    mutationFn: () => apiFetch('/integrations/google-calendar', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['calendar-connection'] }),
  });

  const saveConfig = useMutation({
    mutationFn: (config: SchedulingConfig) => apiFetch(
      '/integrations/google-calendar/config',
      { method: 'PUT', body: JSON.stringify(config) },
    ),
    onSuccess: () => {
      setSaveError(null);
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['calendar-connection'] });
    },
    // El 400 del servidor trae el detalle de qué regla se rompió: se muestra
    // tal cual en vez de un "algo salió mal".
    onError: (error) => setSaveError(error instanceof Error ? error.message : 'Could not save'),
  });

  const config = draft ?? connection.data?.config ?? null;

  function updateConfig(patch: Partial<SchedulingConfig>): void {
    if (!config) return;
    setDraft({ ...config, ...patch });
  }

  function updateDay(day: WeekdayKey, ranges: Array<{ from: string; to: string }>): void {
    if (!config) return;
    setDraft({ ...config, weeklyHours: { ...config.weeklyHours, [day]: ranges } });
  }

  function addRange(day: WeekdayKey): void {
    if (!config) return;
    updateDay(day, [...config.weeklyHours[day], { from: '09:00', to: '17:00' }]);
  }

  function removeRange(day: WeekdayKey, index: number): void {
    if (!config) return;
    updateDay(day, config.weeklyHours[day].filter((_, i) => i !== index));
  }

  function setRangeField(day: WeekdayKey, index: number, field: 'from' | 'to', value: string): void {
    if (!config) return;
    updateDay(day, config.weeklyHours[day].map((range, i) => (i === index ? { ...range, [field]: value } : range)));
  }

  function handleDisconnect(): void {
    // Cortar la conexión detiene el auto-booking de inmediato; confirmar
    // antes evita un clic accidental que rompa el agendamiento en curso.
    if (window.confirm('Disconnect Google Calendar? The assistant will stop booking showings automatically.')) {
      disconnect.mutate();
    }
  }

  if (connection.isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-400">Loading calendar settings…</p>
      </div>
    );
  }

  if (connection.isError || !connection.data) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        Could not load the Google Calendar connection status.
      </div>
    );
  }

  const data = connection.data;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-medium text-slate-900">Scheduling & Calendar</h2>

      {!data.connected && (
        <div className="mt-2">
          <p className="text-sm text-slate-600">
            Without a connected calendar, the assistant can't book showings on its own.
          </p>
          <button
            onClick={() => authorize.mutate()}
            disabled={!canManage || authorize.isPending}
            className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {authorize.isPending ? 'Connecting…' : 'Connect Google Calendar'}
          </button>
          {authorize.isError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              Could not start the Google Calendar connection. Please try again.
            </p>
          )}
        </div>
      )}

      {data.connected && (
        <div className="mt-2 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-600">
              Connected as <span className="font-medium text-slate-900">{data.accountEmail}</span>.
            </p>
            <button
              onClick={handleDisconnect}
              disabled={!canManage || disconnect.isPending}
              className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
          {disconnect.isError && (
            <p role="alert" className="text-sm text-red-600">
              Could not disconnect Google Calendar. Please try again.
            </p>
          )}

          {data.status === 'revoked' && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <p>{data.lastError ?? 'Google revoked access to this calendar.'}</p>
              <button
                onClick={() => authorize.mutate()}
                disabled={!canManage || authorize.isPending}
                className="mt-2 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {authorize.isPending ? 'Reconnecting…' : 'Reconnect'}
              </button>
              {authorize.isError && (
                <p role="alert" className="mt-2 text-xs text-red-700">
                  Could not reconnect. Please try again.
                </p>
              )}
            </div>
          )}

          {config && (
            <div className="space-y-4 border-t border-slate-100 pt-4">
              <div className="space-y-2">
                {WEEKDAYS.map(({ key, label }) => (
                  <div key={key} className="flex items-start gap-3">
                    <span className="w-20 pt-1.5 text-sm text-slate-600">{label}</span>
                    <div className="flex-1 flex flex-wrap items-center gap-2">
                      {config.weeklyHours[key].length === 0 && (
                        <span className="text-xs text-slate-400">No hours set</span>
                      )}
                      {config.weeklyHours[key].map((range, index) => (
                        <div key={index} className="flex items-center gap-1.5">
                          <input
                            type="time"
                            value={range.from}
                            disabled={!canManage}
                            onChange={(event) => setRangeField(key, index, 'from', event.target.value)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs disabled:opacity-50"
                          />
                          <span className="text-xs text-slate-400">–</span>
                          <input
                            type="time"
                            value={range.to}
                            disabled={!canManage}
                            onChange={(event) => setRangeField(key, index, 'to', event.target.value)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs disabled:opacity-50"
                          />
                          <button
                            type="button"
                            onClick={() => removeRange(key, index)}
                            disabled={!canManage}
                            className="text-xs text-red-600 hover:underline disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addRange(key)}
                        disabled={!canManage}
                        className="text-xs text-slate-600 hover:underline disabled:opacity-50"
                      >
                        + Add range
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className="text-xs text-slate-600">
                  Showing duration
                  <select
                    value={config.showingDurationMinutes}
                    disabled={!canManage}
                    onChange={(event) => updateConfig({ showingDurationMinutes: Number(event.target.value) })}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                  >
                    {DURATION_OPTIONS.map((minutes) => (
                      <option key={minutes} value={minutes}>{minutes} min</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-600">
                  Buffer between showings (min)
                  <input
                    type="number"
                    min={0}
                    max={120}
                    value={config.bufferMinutes}
                    disabled={!canManage}
                    onChange={(event) => updateConfig({ bufferMinutes: Number(event.target.value) })}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                  />
                </label>
                <label className="text-xs text-slate-600">
                  Minimum notice (hours)
                  <input
                    type="number"
                    min={0}
                    max={72}
                    value={config.minNoticeHours}
                    disabled={!canManage}
                    onChange={(event) => updateConfig({ minNoticeHours: Number(event.target.value) })}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                  />
                </label>
                <label className="text-xs text-slate-600">
                  Maximum booking window (days)
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={config.maxAdvanceDays}
                    disabled={!canManage}
                    onChange={(event) => updateConfig({ maxAdvanceDays: Number(event.target.value) })}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                  />
                </label>
                <label className="text-xs text-slate-600">
                  Slot granularity
                  <select
                    value={config.slotGranularityMinutes}
                    disabled={!canManage}
                    onChange={(event) => updateConfig({ slotGranularityMinutes: Number(event.target.value) })}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                  >
                    {GRANULARITY_OPTIONS.map((minutes) => (
                      <option key={minutes} value={minutes}>{minutes} min</option>
                    ))}
                  </select>
                </label>
              </div>

              {saveError && (
                <p role="alert" className="text-sm text-red-600">{saveError}</p>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={() => draft && saveConfig.mutate(draft)}
                  disabled={!canManage || !draft || saveConfig.isPending}
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {saveConfig.isPending ? 'Saving…' : 'Save'}
                </button>
                {draft && (
                  <button
                    type="button"
                    onClick={() => { setDraft(null); setSaveError(null); }}
                    disabled={!canManage}
                    className="text-sm text-slate-500 hover:underline disabled:opacity-50"
                  >
                    Discard changes
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

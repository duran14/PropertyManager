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
  { key: 'mon', label: 'Lunes' },
  { key: 'tue', label: 'Martes' },
  { key: 'wed', label: 'Miércoles' },
  { key: 'thu', label: 'Jueves' },
  { key: 'fri', label: 'Viernes' },
  { key: 'sat', label: 'Sábado' },
  { key: 'sun', label: 'Domingo' },
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
    onError: (error) => setSaveError(error instanceof Error ? error.message : 'No se pudo guardar'),
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
    if (window.confirm('¿Desconectar Google Calendar? El asistente dejará de agendar showings automáticamente.')) {
      disconnect.mutate();
    }
  }

  if (connection.isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-400">Cargando configuración de calendario…</p>
      </div>
    );
  }

  if (connection.isError || !connection.data) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        No se pudo cargar el estado de la conexión con Google Calendar.
      </div>
    );
  }

  const data = connection.data;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-medium text-slate-900">Agenda y calendario</h2>

      {!data.connected && (
        <div className="mt-2">
          <p className="text-sm text-slate-600">
            Sin un calendario conectado, el asistente no puede agendar showings por su cuenta.
          </p>
          <button
            onClick={() => authorize.mutate()}
            disabled={!canManage || authorize.isPending}
            className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {authorize.isPending ? 'Conectando…' : 'Conectar Google Calendar'}
          </button>
        </div>
      )}

      {data.connected && (
        <div className="mt-2 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-600">
              Conectado como <span className="font-medium text-slate-900">{data.accountEmail}</span>.
            </p>
            <button
              onClick={handleDisconnect}
              disabled={!canManage || disconnect.isPending}
              className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              Desconectar
            </button>
          </div>

          {data.status === 'revoked' && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <p>{data.lastError ?? 'Google revocó el acceso a este calendario.'}</p>
              <button
                onClick={() => authorize.mutate()}
                disabled={!canManage || authorize.isPending}
                className="mt-2 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {authorize.isPending ? 'Reconectando…' : 'Reconectar'}
              </button>
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
                        <span className="text-xs text-slate-400">Sin horario</span>
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
                            Quitar
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addRange(key)}
                        disabled={!canManage}
                        className="text-xs text-slate-600 hover:underline disabled:opacity-50"
                      >
                        + Agregar rango
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className="text-xs text-slate-600">
                  Duración del showing
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
                  Colchón entre citas (min)
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
                  Aviso mínimo (horas)
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
                  Ventana máxima (días)
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
                  Granularidad de slots
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
                  {saveConfig.isPending ? 'Guardando…' : 'Guardar'}
                </button>
                {draft && (
                  <button
                    type="button"
                    onClick={() => { setDraft(null); setSaveError(null); }}
                    disabled={!canManage}
                    className="text-sm text-slate-500 hover:underline disabled:opacity-50"
                  >
                    Descartar cambios
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

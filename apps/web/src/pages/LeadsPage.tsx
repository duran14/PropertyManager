import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import type { Lead, LeadStatus } from '../lib/types';
import { Icon, type IconName } from '../components/Icon';

const SOURCE_META: Record<string, { label: string; icon: IconName; color: string }> = {
  unit_url: { label: 'URL unidad', icon: 'document', color: 'bg-sky-50 text-sky-700' },
  whatsapp: { label: 'WhatsApp', icon: 'chat', color: 'bg-green-50 text-green-700' },
  sms: { label: 'SMS', icon: 'chat', color: 'bg-blue-50 text-blue-700' },
  showmojo: { label: 'ShowMojo', icon: 'sparkles', color: 'bg-violet-50 text-violet-700' },
  manual: { label: 'Manual', icon: 'hitl', color: 'bg-slate-100 text-slate-700' },
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  new_: { label: 'Nuevo', color: 'bg-blue-100 text-blue-800' },
  contacted: { label: 'Contactado', color: 'bg-amber-100 text-amber-800' },
  tour_scheduled: { label: 'Visita agendada', color: 'bg-purple-100 text-purple-800' },
  qualified: { label: 'Calificado', color: 'bg-teal-100 text-teal-800' },
  converted: { label: 'Convertido', color: 'bg-green-100 text-green-800' },
  lost: { label: 'Perdido', color: 'bg-red-100 text-red-800' },
};

// Siguiente estado del funnel al avanzar.
const NEXT_STATUS: Partial<Record<LeadStatus, LeadStatus>> = {
  new_: 'contacted',
  contacted: 'tour_scheduled',
  tour_scheduled: 'qualified',
  qualified: 'converted',
};

export function LeadsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>('');

  const { data, isLoading } = useQuery<{ leads: Lead[] }>({
    queryKey: ['leads', filter],
    queryFn: () => apiFetch(`/leads${filter ? `?source=${filter}` : ''}`),
  });

  const advanceMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/leads/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });

  const leads = data?.leads ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Leads · Prospecção</h1>
          <p className="text-sm text-slate-500">
            Prospectos captados vía WhatsApp, URLs de unidades y ShowMojo.
          </p>
        </div>
        <div className="flex gap-4 text-center">
          <div className="rounded-lg bg-white border border-slate-200 px-4 py-2">
            <div className="text-2xl font-bold text-slate-900">{leads.length}</div>
            <div className="text-xs text-slate-500">Total</div>
          </div>
          <div className="rounded-lg bg-white border border-slate-200 px-4 py-2">
            <div className="text-2xl font-bold text-blue-600">
              {leads.filter((l) => l.status === 'new_').length}
            </div>
            <div className="text-xs text-slate-500">Nuevos</div>
          </div>
        </div>
      </div>

      {/* Filtros por fuente */}
      <div className="mb-4 flex gap-2 text-sm">
        {['', 'whatsapp', 'unit_url', 'showmojo'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            {f === '' ? 'Todas las fuentes' : SOURCE_META[f]?.label ?? f}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Prospecto</th>
              <th className="text-left px-4 py-3 font-medium">Contacto</th>
              <th className="text-left px-4 py-3 font-medium">Fuente</th>
              <th className="text-left px-4 py-3 font-medium">Unidad</th>
              <th className="text-center px-4 py-3 font-medium">Estado</th>
              <th className="text-left px-4 py-3 font-medium">Fecha</th>
              <th className="text-center px-4 py-3 font-medium">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Cargando...</td></tr>
            )}
            {!isLoading && leads.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                Sin leads todavía. Los leads llegan vía WhatsApp, el formulario de la URL pública de una unidad, o ShowMojo.
              </td></tr>
            )}
            {leads.map((lead) => {
              const sourceMeta = SOURCE_META[lead.source] ?? SOURCE_META.manual;
              const statusMeta = STATUS_META[lead.status] ?? STATUS_META.new_;
              const nextStatus = NEXT_STATUS[lead.status];
              return (
                <tr key={lead.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{lead.name ?? 'Anónimo'}</div>
                    {lead.message && (
                      <div className="text-xs text-slate-400 truncate max-w-xs">"{lead.message}"</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {lead.phone && <div>{lead.phone}</div>}
                    {lead.email && <div>{lead.email}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${sourceMeta.color}`}>
                      <Icon name={sourceMeta.icon} size={12} />
                      {sourceMeta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {lead.unit ? `${lead.unit.name} · ${lead.unit.property.name}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${statusMeta.color}`}>
                      {statusMeta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {new Date(lead.createdAt).toLocaleDateString('en-CA')}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {nextStatus && (
                      <button
                        onClick={() => advanceMutation.mutate({ id: lead.id, status: nextStatus })}
                        disabled={advanceMutation.isPending}
                        className="rounded-md bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
                      >
                        Avanzar → {STATUS_META[nextStatus]?.label}
                      </button>
                    )}
                    {!nextStatus && lead.status === 'converted' && (
                      <span className="text-xs text-green-600">✓ Convertido</span>
                    )}
                    {!nextStatus && lead.status === 'lost' && (
                      <span className="text-xs text-red-500">Perdido</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

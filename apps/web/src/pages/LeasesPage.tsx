import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import type { Lease, RtaDraft } from '../lib/types';

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  draft: 'bg-amber-100 text-amber-800',
  ended: 'bg-slate-100 text-slate-600',
  terminated: 'bg-red-100 text-red-800',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Activo',
  draft: 'Borrador',
  ended: 'Finalizado',
  terminated: 'Terminado',
};

// Los leases se cargan junto con la página; aquí asumimos que llegan por props
// desde una query compartida. Simplificamos con una query local.
export function LeasesPage({ leases }: { leases: Lease[] }) {
  const { user } = useAuth();
  const isBroker = user?.role === 'broker';
  const isPm = user?.role === 'property_manager';
  const canGenerate = isBroker || isPm;

  const [draft, setDraft] = useState<RtaDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generateMutation = useMutation({
    mutationFn: (leaseId: string) =>
      apiFetch<RtaDraft>('/audit/rta/draft', {
        method: 'POST',
        body: JSON.stringify({ leaseId }),
      }),
    onSuccess: (data) => {
      setDraft(data);
      setError(null);
    },
    onError: () => setError('Error al generar el borrador.'),
  });

  const signMutation = useMutation({
    mutationFn: ({ leaseId, signedDocRef }: { leaseId: string; signedDocRef: string }) =>
      apiFetch('/audit/rta/sign', {
        method: 'POST',
        body: JSON.stringify({ leaseId, signedDocRef }),
      }),
    onSuccess: () => {
      setDraft(null);
      setError(null);
    },
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Icon name="rta" size={24} className="text-rose-600" />
          Contratos · RTA-BC
        </h1>
        <p className="text-sm text-slate-500">
          Leases activos y generación de borradores conforme a la Residential Tenancy Act de British Columbia.
        </p>
      </div>

      {/* Disclaimer legal */}
      <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
        <Icon name="warning" size={18} className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          Los documentos generados son <strong>BORRADORES no vinculantes</strong> hasta ser firmados por el Managing Broker.
          El sistema no constituye práctica legal.
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Inquilino</th>
              <th className="text-left px-4 py-3 font-medium">Unidad</th>
              <th className="text-right px-4 py-3 font-medium">Renta</th>
              <th className="text-left px-4 py-3 font-medium">Período</th>
              <th className="text-center px-4 py-3 font-medium">Estado</th>
              <th className="text-center px-4 py-3 font-medium">RTA</th>
              <th className="text-center px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {leases.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Sin contratos.</td></tr>
            )}
            {leases.map((lease) => (
              <tr key={lease.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium">
                  {lease.tenantRecord
                    ? `${lease.tenantRecord.firstName} ${lease.tenantRecord.lastName}`
                    : '—'}
                </td>
                <td className="px-4 py-3 text-slate-600 text-xs">
                  {lease.unit ? `${lease.unit.name} · ${lease.unit.property.city}` : '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono">{formatCents(lease.rentCents)}</td>
                <td className="px-4 py-3 text-slate-600 text-xs">
                  {new Date(lease.startDate).toLocaleDateString('en-CA')}
                  {lease.endDate && ` → ${new Date(lease.endDate).toLocaleDateString('en-CA')}`}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[lease.status] ?? 'bg-slate-100'}`}>
                    {STATUS_LABELS[lease.status] ?? lease.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  {lease.signedDocRef ? (
                    <span className="text-xs text-green-600 font-medium">Firmado ✓</span>
                  ) : lease.rtaDraftDocRef ? (
                    <span className="text-xs text-amber-600">Borrador</span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  {canGenerate && (
                    <button
                      onClick={() => generateMutation.mutate(lease.id)}
                      disabled={generateMutation.isPending}
                      className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
                    >
                      <Icon name="document" size={12} />
                      {lease.rtaDraftDocRef ? 'Regenerar' : 'Generar RTA'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal del borrador RTA */}
      {draft && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
              <h3 className="font-medium">Borrador RTA · {draft.fields.tenantName}</h3>
              <button onClick={() => setDraft(null)} className="text-slate-400 hover:text-slate-600 text-xl">×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap bg-slate-50 rounded-lg p-4">
                {draft.content}
              </pre>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between">
              <p className="text-xs text-amber-700 max-w-md">{draft.disclaimer}</p>
              <div className="flex gap-2">
                {isBroker ? (
                  <button
                    onClick={() =>
                      signMutation.mutate({
                        leaseId: draft.leaseId,
                        signedDocRef: `signed_${draft.draftDocRef}`,
                      })
                    }
                    disabled={signMutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-white text-sm font-medium hover:bg-rose-700"
                  >
                    <Icon name="rta" size={14} />
                    Firmar como Broker
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">Solo el Broker puede firmar</span>
                )}
                <button
                  onClick={() => setDraft(null)}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

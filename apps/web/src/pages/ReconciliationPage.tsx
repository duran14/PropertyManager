import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import type { Discrepancy } from '../lib/types';
import { Icon } from '../components/Icon';

const KIND_LABELS: Record<string, string> = {
  missing_in_qbo: 'Falta en QuickBooks',
  missing_in_buildium: 'Falta en Buildium',
  missing_in_bank: 'Falta en el banco',
  amount_mismatch: 'Monto distinto',
};

const KIND_STYLES: Record<string, string> = {
  missing_in_qbo: 'bg-red-100 text-red-800',
  missing_in_buildium: 'bg-orange-100 text-orange-800',
  missing_in_bank: 'bg-amber-100 text-amber-800',
  amount_mismatch: 'bg-purple-100 text-purple-800',
};

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
}

export function ReconciliationPage() {
  const queryClient = useQueryClient();

  const { data: discData, isLoading } = useQuery<{ discrepancies: Discrepancy[] }>({
    queryKey: ['discrepancies'],
    queryFn: () => apiFetch('/reconciliation/discrepancies'),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      apiFetch<{
        batchId: string;
        balanced: boolean;
        reconciledCount: number;
        discrepancyCount: number;
      }>('/reconciliation/run', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['discrepancies'] }),
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/reconciliation/discrepancies/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['discrepancies'] }),
  });

  const discrepancies = discData?.discrepancies ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Reconciliación</h1>
          <p className="text-sm text-slate-500">
            Matching diario Buildium ↔ Banco ↔ QuickBooks. Discrepancias = "agujeros" por resolver.
          </p>
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-white font-medium shadow-sm shadow-teal-600/20 hover:bg-teal-700 disabled:opacity-50"
        >
          <Icon name="refresh" size={18} />
          {runMutation.isPending ? 'Ejecutando...' : 'Ejecutar reconciliación'}
        </button>
      </div>

      {runMutation.isSuccess && (
        <div className="mb-4 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-700">
          Reconciliación ejecutada: {runMutation.data.reconciledCount} reconciliados,{' '}
          {runMutation.data.discrepancyCount} discrepancias. Balance{' '}
          {runMutation.data.balanced ? '✅ cuadrado' : '⚠️ descuadrado'}.
        </div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="font-medium">Discrepancias pendientes ({discrepancies.length})</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="text-slate-600 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Tipo</th>
              <th className="text-left px-4 py-3 font-medium">Referencia</th>
              <th className="text-right px-4 py-3 font-medium">Monto</th>
              <th className="text-left px-4 py-3 font-medium">Fecha batch</th>
              <th className="text-center px-4 py-3 font-medium">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Cargando...</td></tr>
            )}
            {!isLoading && discrepancies.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Sin discrepancias. Todo cuadrado. 🎉</td></tr>
            )}
            {discrepancies.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${KIND_STYLES[d.kind] ?? 'bg-slate-100'}`}>
                    {KIND_LABELS[d.kind] ?? d.kind}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{d.entryReference}</td>
                <td className="px-4 py-3 text-right font-mono">{formatMoney(d.entryAmountCents)}</td>
                <td className="px-4 py-3 text-slate-600">
                  {d.reconciliationBatch ? new Date(d.reconciliationBatch.runDate).toLocaleDateString('en-CA') : '—'}
                </td>
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => resolveMutation.mutate(d.id)}
                    disabled={d.resolved || resolveMutation.isPending}
                    className="rounded bg-slate-200 px-2 py-1 text-xs hover:bg-slate-300 disabled:opacity-50"
                  >
                    {d.resolved ? '✓ Resuelto' : 'Marcar resuelto'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

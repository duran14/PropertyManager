import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { Icon } from '../components/Icon';
import type { SentinelStatus } from '../lib/types';

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
}

export function SentinelPage() {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [sender, setSender] = useState('');

  const { data: status, isLoading } = useQuery<SentinelStatus>({
    queryKey: ['sentinel-status'],
    queryFn: () => apiFetch('/sentinel/status'),
    refetchInterval: 5000, // refresh para ver jobs procesándose
  });

  const paymentMutation = useMutation({
    mutationFn: (input: { amountCents: number; reference: string; senderName?: string }) =>
      apiFetch('/sentinel/process-payment', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sentinel-status'] });
      setAmount('');
      setReference('');
      setSender('');
    },
  });

  const reconcileMutation = useMutation({
    mutationFn: () => apiFetch('/sentinel/reconcile', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sentinel-status'] }),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || !reference) return;
    paymentMutation.mutate({ amountCents: cents, reference, senderName: sender || undefined });
  }

  const recentActions = status?.recentActions ?? [];
  const bankQueue = status?.queues.bankNotification;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Icon name="sentinel" size={24} className="text-violet-600" />
          Financial Sentinel
        </h1>
        <p className="text-sm text-slate-500">
          El agente IA procesa e-Transfers bancarios: identifica el inquilino, calcula confianza y decide auto-aprobar o pedir revisión humana.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Panel izquierdo: simular e-Transfer */}
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <h2 className="font-medium mb-1 flex items-center gap-2">
              <Icon name="etransfer" size={18} className="text-teal-600" />
              Procesar e-Transfer
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Simula un aviso bancario entrante. El Sentinel lo procesará en background.
            </p>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Monto (CAD)</label>
                <input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="2400.00"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Referencia</label>
                <input
                  type="text"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="ETR-2026-0708-XXXX"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Remitente (opcional)</label>
                <input
                  type="text"
                  value={sender}
                  onChange={(e) => setSender(e.target.value)}
                  placeholder="Sarah Chen"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>
              {paymentMutation.isError && (
                <p className="text-xs text-red-600">Error al encolar el e-Transfer.</p>
              )}
              {paymentMutation.isSuccess && (
                <p className="text-xs text-green-600">✓ e-Transfer encolado. El worker lo procesará en segundos.</p>
              )}
              <button
                type="submit"
                disabled={paymentMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-white font-medium shadow-sm shadow-violet-600/20 hover:bg-violet-700 disabled:opacity-50"
              >
                <Icon name="etransfer" size={16} />
                {paymentMutation.isPending ? 'Encolando...' : 'Procesar e-Transfer'}
              </button>
            </form>
          </div>

          {/* Estado de colas */}
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <h2 className="font-medium mb-3">Estado de colas (BullMQ)</h2>
            {isLoading ? (
              <p className="text-sm text-slate-400">Cargando...</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <QueueCard
                  title="Reconciliación"
                  counts={status?.queues.reconciliation}
                  color="text-teal-600"
                />
                <QueueCard
                  title="e-Transfer"
                  counts={bankQueue}
                  color="text-violet-600"
                />
              </div>
            )}
            <button
              onClick={() => reconcileMutation.mutate()}
              disabled={reconcileMutation.isPending}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-white text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
            >
              <Icon name="refresh" size={16} />
              {reconcileMutation.isPending ? 'Encolando...' : 'Ejecutar reconciliación'}
            </button>
          </div>
        </div>

        {/* Panel derecho: actividad reciente del Sentinel */}
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <h2 className="font-medium mb-3">Actividad reciente del agente IA</h2>
          {recentActions.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">
              Sin actividad. Procesa un e-Transfer para ver al Sentinel en acción.
            </p>
          ) : (
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {recentActions.map((action, i) => {
                const p = action.payload as Record<string, unknown>;
                const decision = p.decision as string | undefined;
                const score = p.score as number | undefined;
                const amtCents = p.amountCents as number | undefined;
                const reasons = p.reasons as string[] | undefined;
                return (
                  <div key={i} className="rounded-lg border border-slate-100 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs text-slate-700">{action.action}</span>
                      <span className="text-xs text-slate-400">
                        {new Date(action.occurredAt).toLocaleTimeString('en-CA')}
                      </span>
                    </div>
                    {amtCents !== undefined && (
                      <div className="text-sm font-medium">{formatCents(amtCents)}</div>
                    )}
                    {decision && (
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            decision === 'auto_approve'
                              ? 'bg-green-100 text-green-700'
                              : decision === 'review'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {decision === 'auto_approve' ? 'Auto-aprobado' : decision === 'review' ? 'Revisión humana' : 'Rechazado'}
                        </span>
                        {score !== undefined && (
                          <span className="text-xs text-slate-500">
                            confianza {(score * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                    )}
                    {reasons && reasons.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {reasons.map((r) => (
                          <span key={r} className="text-[10px] text-slate-400 bg-slate-50 rounded px-1.5 py-0.5">
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueCard({
  title,
  counts,
  color,
}: {
  title: string;
  counts?: Record<string, number>;
  color: string;
}) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className={`text-xs font-medium ${color}`}>{title}</div>
      <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
        <Stat label="Espera" value={counts?.waiting ?? 0} />
        <Stat label="Activos" value={counts?.active ?? 0} />
        <Stat label="Hechos" value={counts?.completed ?? 0} color="text-green-600" />
        <Stat label="Fallidos" value={counts?.failed ?? 0} color={counts?.failed ? 'text-red-600' : ''} />
      </div>
    </div>
  );
}

function Stat({ label, value, color = '' }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <span className={`font-bold ${color || 'text-slate-700'}`}>{value}</span>
      <span className="text-slate-400 ml-1">{label}</span>
    </div>
  );
}

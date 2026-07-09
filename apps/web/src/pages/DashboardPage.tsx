import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Brain } from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import { useAuth } from '../auth/AuthContext';
import type { Bill, Discrepancy, Lead, SentinelStatus } from '../lib/types';
import { Icon, IconBadge, ICON_COLORS, Robot, type IconName } from '../components/Icon';

export function DashboardPage() {
  const { user } = useAuth();

  const { data: billsData } = useQuery<{ bills: Bill[] }>({
    queryKey: ['bills'],
    queryFn: () => apiFetch('/bills'),
  });
  const { data: discData } = useQuery<{ discrepancies: Discrepancy[] }>({
    queryKey: ['discrepancies'],
    queryFn: () => apiFetch('/reconciliation/discrepancies'),
  });
  const { data: leadsData } = useQuery<{ leads: Lead[] }>({
    queryKey: ['leads'],
    queryFn: () => apiFetch('/leads'),
  });
  const { data: sentinelData } = useQuery<SentinelStatus>({
    queryKey: ['sentinel-status'],
    queryFn: () => apiFetch('/sentinel/status'),
  });

  const bills = billsData?.bills ?? [];
  const discrepancies = discData?.discrepancies ?? [];
  const leads = leadsData?.leads ?? [];
  const sentinelActions = sentinelData?.recentActions ?? [];

  const pendingReview = bills.filter((b) => b.status === 'pending_review').length;
  const synced = bills.filter((b) => b.status === 'synced_to_qbo').length;
  const newLeads = leads.filter((l) => l.status === 'new_').length;

  const stats = [
    { label: 'Leads nuevos', value: newLeads, icon: 'leads' as IconName, link: '/leads' },
    { label: 'Facturas en revisión', value: pendingReview, icon: 'pending' as IconName, link: '/bills' },
    { label: 'Sincronizadas a QBO', value: synced, icon: 'approve' as IconName, link: '/bills' },
    { label: 'Discrepancias abiertas', value: discrepancies.filter((d) => !d.resolved).length, icon: 'warning' as IconName, link: '/reconciliation' },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Hola, {user?.firstName}</h1>
        <p className="text-sm text-slate-500">{user?.tenantName} · Resumen del Puente Contable</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            to={stat.link}
            className="bg-white rounded-lg border border-slate-200 p-5 hover:border-brand-300 hover:shadow-sm transition"
          >
            <div className="flex items-center gap-3">
              <IconBadge name={stat.icon} />
              <div>
                <span className="block text-3xl font-bold text-slate-900 leading-none">{stat.value}</span>
                <p className="text-sm text-slate-600 mt-1.5">{stat.label}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Flujo del Puente Contable */}
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <h2 className="font-medium mb-4">Flujo del Puente Contable</h2>
          <div className="flex items-center gap-3 text-xs text-slate-600 overflow-x-auto pb-2">
            <FlowStep icon="receipt" label="Recibo" />
            <Arrow />
            <FlowStep icon="ocr" label="OCR · GLM" sub="extracción IA" />
            <Arrow />
            <FlowStep icon="confidence" label="Confidence" />
            <Arrow />
            <FlowStep icon="hitl" label="HITL" sub="si confianza baja" />
            <Arrow />
            <FlowStep icon="qbo" label="QuickBooks" />
          </div>
          <p className="text-xs text-slate-400 mt-4 flex items-center gap-1.5">
            <Icon name="warning" size={14} className="text-amber-500" />
            El sistema nunca mueve dinero (Regla de Oro). Solo genera instrucciones contables.
          </p>
        </div>

        {/* Actividad reciente del Sentinel */}
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium flex items-center gap-2">
              <Icon name="sentinel" size={18} className="text-violet-600" />
              Actividad del Sentinel
            </h2>
            <Link to="/sentinel" className="text-xs text-brand-600 hover:underline">Ver todo →</Link>
          </div>
          {sentinelActions.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">Sin actividad reciente.</p>
          ) : (
            <div className="space-y-2">
              {sentinelActions.slice(0, 4).map((a, i) => {
                const p = a.payload as Record<string, unknown>;
                const decision = p.decision as string | undefined;
                const amt = p.amountCents as number | undefined;
                return (
                  <div key={i} className="flex items-center justify-between text-xs border-b border-slate-50 pb-2">
                    <span className="font-mono text-slate-600">{a.action}</span>
                    <div className="flex items-center gap-2">
                      {amt !== undefined && <span className="text-slate-700">${(amt / 100).toFixed(0)}</span>}
                      {decision && (
                        <span className={`rounded-full px-1.5 py-0.5 ${
                          decision === 'auto_approve' ? 'bg-green-100 text-green-700'
                            : decision === 'review' ? 'bg-amber-100 text-amber-700'
                              : 'bg-red-100 text-red-700'
                        }`}>
                          {decision === 'auto_approve' ? 'auto' : decision}
                        </span>
                      )}
                    </div>
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

function FlowStep({
  icon,
  label,
  sub,
}: {
  icon: IconName;
  label: string;
  sub?: string;
}) {
  const color = ICON_COLORS[icon];
  return (
    <div className="flex flex-col items-center min-w-[72px]">
      <span
        className={`inline-flex items-center justify-center w-12 h-12 rounded-xl mb-1.5 ${color.badge}`}
      >
        {icon === 'ocr' ? (
          <AiGlyph />
        ) : (
          <Icon name={icon} size={22} className={color.text} />
        )}
      </span>
      <span className="font-medium text-slate-700">{label}</span>
      {sub && <span className="text-slate-400 text-[10px]">{sub}</span>}
    </div>
  );
}

/**
 * Glifo de IA: robot con un cerebro superpuesto, en tonos violeta.
 * El cuerpo del robot es violeta-600 y el cerebro violeta-300 con relleno.
 */
function AiGlyph() {
  return (
    <span className="relative inline-flex items-center justify-center">
      <Robot size={24} strokeWidth={1.75} className="text-violet-600" />
      <Brain size={13} strokeWidth={2} className="absolute -top-1 -right-1.5 text-violet-400 fill-violet-200" />
    </span>
  );
}

function Arrow() {
  return <span className="text-slate-300 shrink-0">→</span>;
}

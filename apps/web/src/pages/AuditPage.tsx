import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import type { AuditEntry, ChainVerification } from '../lib/types';

const ACTOR_STYLES: Record<string, { badge: string; text: string; label: string }> = {
  user: { badge: 'bg-blue-50', text: 'text-blue-700', label: 'User' },
  system: { badge: 'bg-slate-100', text: 'text-slate-700', label: 'System' },
  ai_agent: { badge: 'bg-violet-50', text: 'text-violet-700', label: 'AI' },
};

export function AuditPage() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<string>('');

  const { data, isLoading } = useQuery<{ entries: AuditEntry[]; count: number }>({
    queryKey: ['audit', filter],
    queryFn: () => apiFetch(`/audit/trail${filter ? `?actorType=${filter}` : ''}`),
  });

  const verifyMutation = useMutation({
    mutationFn: () => apiFetch<ChainVerification>('/audit/verify-chain', { method: 'POST' }),
  });

  const entries = data?.entries ?? [];
  const canVerify = user?.role === 'bookkeeper' || user?.role === 'broker';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Audit Trail</h1>
          <p className="text-sm text-slate-500">
            Immutable hash-chained log. Every user and AI action is traceable.
          </p>
        </div>
        {canVerify && (
          <button
            onClick={() => verifyMutation.mutate()}
            disabled={verifyMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-white font-medium shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:opacity-50"
          >
            <Icon name="audit" size={18} />
            {verifyMutation.isPending ? 'Verifying...' : 'Verify chain'}
          </button>
        )}
      </div>

      {verifyMutation.data && (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            verifyMutation.data.intact
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {verifyMutation.data.intact ? (
            <>Chain intact: {verifyMutation.data.totalEntries} entries verified. No tampering detected.</>
          ) : (
            <>Broken chain at entry #{verifyMutation.data.firstBrokenIndex}. Possible audit log tampering.</>
          )}
        </div>
      )}

      <div className="mb-4 flex gap-2 text-sm">
        {['', 'user', 'system', 'ai_agent'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            {f === '' ? 'All' : ACTOR_STYLES[f]?.label ?? f}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Action</th>
              <th className="text-left px-4 py-3 font-medium">Actor</th>
              <th className="text-left px-4 py-3 font-medium">Entity</th>
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-left px-4 py-3 font-medium">Hash prefix</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
            )}
            {!isLoading && entries.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No audit entries yet.</td></tr>
            )}
            {entries.map((entry) => {
              const style = ACTOR_STYLES[entry.actorType] ?? ACTOR_STYLES.system;
              return (
                <tr key={entry.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs">{entry.action}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${style.badge} ${style.text}`}>
                      {style.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {entry.entityType} / {entry.entityId.slice(-8)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {new Date(entry.occurredAt).toLocaleString('en-CA')}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{entry.hash.slice(0, 12)}...</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {entries.length > 0 && (
        <p className="text-xs text-slate-400 mt-3">
          Showing the {entries.length} most recent entries. Entries are append-only with no update or delete path.
        </p>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';

type Property = {
  id: string;
  name: string;
  ownerId: string | null;
  managementFeePercentBps: number;
  reserveFundTargetCents: number;
};

type Preview = {
  propertyName: string;
  ownerName: string | null;
  period: string;
  appliedFeePercentBps: number;
  reserveTargetCents: number;
  reserveAlreadyWithheldCents: number;
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  ownerPayoutCents: number;
  shortfallCents: number;
  alreadyClosed: boolean;
};

type Statement = {
  id: string;
  periodStart: string;
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  ownerPayoutCents: number;
  shortfallCents: number;
};

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function OwnerStatementsPage() {
  const queryClient = useQueryClient();
  const [propertyId, setPropertyId] = useState<string>('');
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [error, setError] = useState<string | null>(null);

  const properties = useQuery<{ properties: Property[] }>({
    queryKey: ['properties'],
    queryFn: () => apiFetch('/properties'),
  });

  const preview = useQuery<{ preview: Preview }>({
    queryKey: ['statement-preview', propertyId, period],
    queryFn: () => apiFetch(`/properties/${propertyId}/statement-preview?period=${period}`),
    enabled: Boolean(propertyId && period),
    retry: false,
  });

  const history = useQuery<{ statements: Statement[] }>({
    queryKey: ['statements', propertyId],
    queryFn: () => apiFetch(`/properties/${propertyId}/statements`),
    enabled: Boolean(propertyId),
  });

  const closeMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/properties/${propertyId}/statements`, {
        method: 'POST',
        body: JSON.stringify({ period }),
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['statement-preview', propertyId, period] });
      void queryClient.invalidateQueries({ queryKey: ['statements', propertyId] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not close this period');
    },
  });

  const selected = properties.data?.properties.find((p) => p.id === propertyId);
  const p = preview.data?.preview;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Owner Statements</h1>
        <p className="mt-1 text-sm text-slate-600">
          Monthly settlement per property. Amounts are calculated from recorded rent payments and
          approved bills — closing a period issues a statement, it does not move any funds.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select
          value={propertyId}
          onChange={(event) => { setPropertyId(event.target.value); setError(null); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">Select a property…</option>
          {properties.data?.properties.map((property) => (
            <option key={property.id} value={property.id}>{property.name}</option>
          ))}
        </select>
        <input
          type="month"
          value={period}
          onChange={(event) => { setPeriod(event.target.value); setError(null); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {selected && !selected.ownerId && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          This property has no owner assigned, so its statements cannot be closed.
        </div>
      )}

      {preview.isError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load the preview for this period.
        </div>
      )}

      {p && (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-medium text-slate-900">
            {p.propertyName} — {p.period}
          </h2>
          <p className="text-sm text-slate-600">Owner: {p.ownerName ?? 'Not assigned'}</p>

          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Rent income" value={money(p.rentIncomeCents)} />
            <Row label="Expenses" value={`− ${money(p.expensesCents)}`} />
            <Row
              label={`Management fee (${(p.appliedFeePercentBps / 100).toFixed(2)}%)`}
              value={`− ${money(p.managementFeeCents)}`}
            />
            <Row
              label={`Reserve withheld (target ${money(p.reserveTargetCents)}, held ${money(p.reserveAlreadyWithheldCents)})`}
              value={`− ${money(p.reserveWithheldCents)}`}
            />
            <div className="border-t border-slate-200 pt-2">
              {p.shortfallCents > 0 ? (
                <Row label="Owed by owner" value={money(p.shortfallCents)} strong />
              ) : (
                <Row label="Owner payout" value={money(p.ownerPayoutCents)} strong />
              )}
            </div>
          </dl>

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>
          )}

          <button
            onClick={() => closeMutation.mutate()}
            disabled={p.alreadyClosed || closeMutation.isPending}
            className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {p.alreadyClosed ? 'Period already closed' : closeMutation.isPending ? 'Closing…' : 'Close period'}
          </button>
        </div>
      )}

      {history.data?.statements?.length ? (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-medium text-slate-900">Closed statements</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {history.data.statements.map((statement) => (
              <li key={statement.id} className="flex justify-between py-2">
                <span className="text-slate-700">
                  {new Date(statement.periodStart).toLocaleDateString('en-CA', {
                    year: 'numeric', month: 'long', timeZone: 'UTC',
                  })}
                </span>
                <span className="font-medium text-slate-900">
                  {statement.shortfallCents > 0
                    ? `− ${money(statement.shortfallCents)}`
                    : money(statement.ownerPayoutCents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? 'font-medium text-slate-900' : 'text-slate-600'}>{label}</dt>
      <dd className={strong ? 'font-semibold text-slate-900' : 'text-slate-800'}>{value}</dd>
    </div>
  );
}

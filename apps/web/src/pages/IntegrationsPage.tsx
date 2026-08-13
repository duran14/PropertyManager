import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { useAuth } from '../auth/AuthContext';

interface IntegrationStatus {
  provider: 'frontlobby_portal' | 'sterling_portal';
  status: string;
  lastSyncedAt: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  frontlobby_portal: 'FrontLobby (credit check)',
  sterling_portal: 'Sterling (criminal record check)',
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  not_configured: { label: 'Not connected', color: 'text-slate-500' },
  pending: { label: 'Saved, not yet verified', color: 'text-amber-600' },
  connected: { label: 'Connected', color: 'text-green-600' },
  error: { label: 'Connection error', color: 'text-red-600' },
};

export function IntegrationsPage() {
  const { user } = useAuth();
  const canManage = user?.role === 'property_manager';
  const queryClient = useQueryClient();
  // La contraseña nunca se pre-llena desde la respuesta de GET /integrations
  // — la API nunca la devuelve — así que cada draft arranca vacío.
  const [drafts, setDrafts] = useState<Record<string, { username: string; password: string }>>({});
  const [savedProvider, setSavedProvider] = useState<string | null>(null);

  const integrations = useQuery<{ integrations: IntegrationStatus[] }>({
    queryKey: ['integrations'],
    queryFn: () => apiFetch('/integrations'),
  });

  const save = useMutation({
    mutationFn: (input: { provider: string; username: string; password: string }) =>
      apiFetch('/integrations', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (_, variables) => {
      setSavedProvider(variables.provider);
      // Limpia el draft de esa tarjeta (incluida la contraseña) para no
      // dejarla visible en el formulario después de guardar.
      setDrafts((prev) => ({ ...prev, [variables.provider]: { username: '', password: '' } }));
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  function draftFor(provider: string) {
    return drafts[provider] ?? { username: '', password: '' };
  }

  function updateDraft(provider: string, field: 'username' | 'password', value: string) {
    setDrafts((prev) => ({ ...prev, [provider]: { ...draftFor(provider), [field]: value } }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Integrations</h1>
        <p className="mt-1 text-sm text-slate-600">
          Credentials for the tenant screening portals (credit and criminal record checks). Stored
          encrypted — the password is never shown back once saved.
        </p>
      </div>

      {!canManage && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Only property managers can update these credentials.
        </div>
      )}

      {integrations.isError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load the integrations status.
        </div>
      )}

      <div className="space-y-4">
        {integrations.data?.integrations.map((integration) => {
          const draft = draftFor(integration.provider);
          const statusMeta = STATUS_LABELS[integration.status] ?? { label: integration.status, color: 'text-slate-500' };
          const isSaving = save.isPending && save.variables?.provider === integration.provider;

          return (
            <div key={integration.provider} className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium text-slate-900">
                  {PROVIDER_LABELS[integration.provider] ?? integration.provider}
                </h2>
                <span className={`text-sm font-medium ${statusMeta.color}`}>{statusMeta.label}</span>
              </div>
              {integration.lastSyncedAt && (
                <p className="mt-1 text-xs text-slate-500">
                  Last synced: {new Date(integration.lastSyncedAt).toLocaleString('en-CA')}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-3">
                <input
                  type="text"
                  placeholder="Username"
                  value={draft.username}
                  onChange={(event) => updateDraft(integration.provider, 'username', event.target.value)}
                  disabled={!canManage}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={draft.password}
                  onChange={(event) => updateDraft(integration.provider, 'password', event.target.value)}
                  disabled={!canManage}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                />
                <button
                  onClick={() =>
                    save.mutate({ provider: integration.provider, username: draft.username, password: draft.password })
                  }
                  disabled={!canManage || isSaving || !draft.username || !draft.password}
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {isSaving ? 'Saving…' : 'Save credentials'}
                </button>
              </div>

              {save.isError && save.variables?.provider === integration.provider && (
                <p role="alert" className="mt-2 text-sm text-red-600">
                  {save.error instanceof Error ? save.error.message : 'Could not save these credentials'}
                </p>
              )}
              {savedProvider === integration.provider && !save.isError && (
                <p className="mt-2 text-sm text-green-700">Credentials saved.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

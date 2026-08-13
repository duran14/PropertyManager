import { type ChangeEvent, type FormEvent, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';

type ApplicationSummary = {
  status: string;
  tenantName: string;
  showingAt: string;
  unit: { name: string; property: { name: string; address: string; city: string; province: string } } | null;
};

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Mismo tope que MAX_ID_DOCUMENT_BASE64_LENGTH en
// apps/api/src/services/rental-application.service.ts (1_500_000
// caracteres de base64). Base64 infla ~4/3, así que el límite real de
// archivo es ese tope * 3/4 bytes. Validamos aquí en bytes crudos, antes
// de convertir, para no hacer trabajar al navegador de balde.
const MAX_ID_DOCUMENT_BASE64_LENGTH = 1_500_000;
const MAX_ID_DOCUMENT_BYTES = Math.floor((MAX_ID_DOCUMENT_BASE64_LENGTH * 3) / 4);
const MAX_ID_DOCUMENT_MB = (MAX_ID_DOCUMENT_BYTES / (1024 * 1024)).toFixed(1);

// Export nombrado, no default: es la convención de las páginas de este
// repo (ver ShortlistPage).
export function ApplyPage() {
  const { token = '' } = useParams();
  const [idFile, setIdFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery<ApplicationSummary>({
    queryKey: ['application', token],
    queryFn: () => apiFetch(`/public/applications/${token}`),
    retry: false,
  });

  const submit = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiFetch(`/public/applications/${token}`, { method: 'POST', body: JSON.stringify(payload) }),
  });

  function handleIdFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > MAX_ID_DOCUMENT_BYTES) {
      setError(
        `That file is too large (max ~${MAX_ID_DOCUMENT_MB} MB). Try taking the photo at a lower resolution, or upload a smaller image.`,
      );
      setIdFile(null);
      event.target.value = '';
      return;
    }
    setError(null);
    setIdFile(file);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = {
      annualIncome: form.get('annualIncome') ? Number(form.get('annualIncome')) : null,
      employerName: form.get('employerName') || null,
      references: form.get('references') || null,
      applicantFullName: String(form.get('applicantFullName') ?? ''),
      dateOfBirth: String(form.get('dateOfBirth') ?? ''),
      currentAddress: String(form.get('currentAddress') ?? ''),
      currentCity: String(form.get('currentCity') ?? ''),
      currentProvince: String(form.get('currentProvince') ?? ''),
      currentPostalCode: String(form.get('currentPostalCode') ?? ''),
      consentApplication: form.get('consentApplication') === 'on',
      consentCreditCheck: form.get('consentCreditCheck') === 'on',
      consentPoliceCheck: form.get('consentPoliceCheck') === 'on',
    };
    if (idFile) {
      payload.idDocumentFilename = idFile.name;
      payload.idDocumentMimeType = idFile.type;
      payload.idDocumentBase64 = await fileToBase64(idFile);
    }
    try {
      await submit.mutateAsync(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit your application');
    }
  }

  if (summary.isLoading) {
    return <div className="p-8 text-center text-slate-500">Loading…</div>;
  }
  if (summary.isError || !summary.data) {
    return (
      <div className="p-8 text-center text-slate-600">
        This application link is no longer valid. Please contact your property manager.
      </div>
    );
  }
  if (summary.data.status === 'submitted' || submit.isSuccess) {
    return (
      <div className="p-8 text-center text-slate-700">
        Thanks! Your application has been submitted. We&apos;ll be in touch shortly.
      </div>
    );
  }

  const unit = summary.data.unit;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Rental application</h1>
      <p className="mt-1 text-sm text-slate-600">
        {summary.data.tenantName}
        {unit ? ` — ${unit.property.name}, ${unit.name}` : ''}
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Annual income (CAD)</span>
          <input name="annualIncome" type="number" min="0" step="1" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Employer</span>
          <input name="employerName" type="text" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">References</span>
          <textarea name="references" rows={3} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Photo ID</span>
          <input
            type="file"
            required
            accept="image/*,application/pdf"
            onChange={handleIdFileChange}
            className="mt-1 w-full text-sm"
          />
        </label>

        <fieldset className="space-y-2 rounded-md border border-slate-200 p-4">
          <legend className="px-1 text-sm font-medium text-slate-700">Authorizations (all required)</legend>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input name="consentApplication" type="checkbox" required className="mt-0.5" />
            I confirm the information above is accurate and authorize its use to process this application.
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input name="consentCreditCheck" type="checkbox" required className="mt-0.5" />
            I authorize a credit check.
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input name="consentPoliceCheck" type="checkbox" required className="mt-0.5" />
            I authorize a criminal record (police) check.
          </label>
        </fieldset>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Full legal name (acts as your signature)</span>
          <input name="applicantFullName" type="text" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Date of birth</span>
          <input name="dateOfBirth" type="date" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Current address</span>
          <input name="currentAddress" type="text" required placeholder="Street address" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <div className="grid grid-cols-3 gap-2">
          <input name="currentCity" type="text" required placeholder="City" className="mt-1 rounded-md border border-slate-300 px-3 py-2" />
          <input name="currentProvince" type="text" required placeholder="Province" className="mt-1 rounded-md border border-slate-300 px-3 py-2" />
          <input name="currentPostalCode" type="text" required placeholder="Postal code" className="mt-1 rounded-md border border-slate-300 px-3 py-2" />
        </div>

        {error && (
          <p role="alert" aria-live="polite" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submit.isPending}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {submit.isPending ? 'Submitting…' : 'Submit application'}
        </button>
      </form>
    </div>
  );
}

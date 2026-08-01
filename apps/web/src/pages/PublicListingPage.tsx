import { useState } from 'react';
import type { FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';

interface PublicUnit {
  name: string;
  slug: string;
  rentCents: number;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  amenities: string[];
  petPolicy: string | null;
  parking: string | null;
  utilities: string | null;
  availableFrom: string | null;
  photos: Array<{ url: string; isPrimary: boolean }>;
  property: { name: string; address: string; city: string; province: string };
}

export function PublicListingPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const tenant = params.get('tenant') ?? '';
  const [submitted, setSubmitted] = useState(false);
  const { data, isLoading, error } = useQuery<{ unit: PublicUnit }>({
    queryKey: ['public-listing', tenant, slug],
    queryFn: () => apiFetch(`/public/units/${encodeURIComponent(slug)}?tenant=${encodeURIComponent(tenant)}`),
    enabled: Boolean(slug && tenant),
  });
  const contact = useMutation({
    mutationFn: (body: Record<string, string>) => apiFetch(
      `/public/units/${encodeURIComponent(slug)}/contact?tenant=${encodeURIComponent(tenant)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: () => setSubmitted(true),
  });

  if (isLoading) return <main className="grid min-h-screen place-items-center bg-slate-950 text-white">Loading property…</main>;
  if (error || !data?.unit) return <main className="grid min-h-screen place-items-center bg-slate-950 text-white">This listing is unavailable.</main>;
  const unit = data.unit;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    contact.mutate(Object.fromEntries(values.entries()) as Record<string, string>);
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <section className="bg-slate-950 px-6 py-12 text-white">
        <div className="mx-auto max-w-6xl">
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">{unit.property.city}, {unit.property.province}</p>
          <h1 className="text-4xl font-bold tracking-tight md:text-6xl">{unit.property.name}</h1>
          <p className="mt-3 text-xl text-slate-300">{unit.name} · ${(unit.rentCents / 100).toLocaleString('en-CA')}/month</p>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-10 lg:grid-cols-[1.5fr_0.8fr]">
        <div>
          {unit.photos.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {unit.photos.map((photo, index) => (
                <img key={photo.url} src={photo.url} alt={`${unit.property.name} photo ${index + 1}`} loading={index ? 'lazy' : 'eager'} className="h-72 w-full rounded-2xl object-cover shadow-sm" />
              ))}
            </div>
          ) : (
            <div className="grid h-72 place-items-center rounded-2xl bg-slate-200 text-slate-600">Photos coming soon</div>
          )}
          <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold">Property details</h2>
            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Detail label="Bedrooms" value={unit.bedrooms ?? '—'} />
              <Detail label="Bathrooms" value={unit.bathrooms ?? '—'} />
              <Detail label="Square feet" value={unit.squareFeet?.toLocaleString() ?? '—'} />
              <Detail label="Pets" value={unit.petPolicy ?? 'Ask us'} />
            </div>
            <p className="mt-6 text-slate-600">{unit.property.address}, {unit.property.city}, {unit.property.province}</p>
            {unit.amenities.length > 0 && <p className="mt-3 text-slate-600"><strong>Amenities:</strong> {unit.amenities.join(', ')}</p>}
          </div>
        </div>

        <aside className="h-fit rounded-2xl bg-white p-6 shadow-lg lg:sticky lg:top-6">
          <h2 className="text-2xl font-semibold">Schedule a visit</h2>
          <p className="mt-2 text-slate-600">Tell us how to reach you and our leasing team will follow up with available times.</p>
          {submitted ? (
            <div className="mt-6 rounded-xl bg-emerald-50 p-4 font-medium text-emerald-800">Thanks! We received your request.</div>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={submit}>
              <input name="name" required placeholder="Your name" className="w-full rounded-xl border border-slate-300 px-4 py-3" />
              <input name="email" type="email" placeholder="Email" className="w-full rounded-xl border border-slate-300 px-4 py-3" />
              <input name="phone" placeholder="Phone" className="w-full rounded-xl border border-slate-300 px-4 py-3" />
              <textarea name="message" placeholder="Preferred day or time" className="min-h-28 w-full rounded-xl border border-slate-300 px-4 py-3" />
              <button disabled={contact.isPending} className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                {contact.isPending ? 'Sending…' : 'Request a tour'}
              </button>
            </form>
          )}
        </aside>
      </div>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string | number }) {
  return <div><p className="text-sm text-slate-500">{label}</p><p className="mt-1 font-semibold">{value}</p></div>;
}

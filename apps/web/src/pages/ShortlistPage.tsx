import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';

type Unit = {
  id: string;
  name: string;
  rentCents: number;
  bedrooms: number | null;
  bathrooms: number | null;
  petPolicy: string | null;
  availableFrom: string | null;
  property: { name: string; address: string; city: string; province: string };
  photos: Array<{ url: string }>;
};

type CatalogUnit = {
  id: string;
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
  property: { name: string; address: string; city: string; province: string };
  photos: Array<{ url: string; isPrimary: boolean }>;
};

type Shortlist = {
  units: Unit[];
  selectedUnitId?: string;
  contact: { name: string; phone: string; email: string };
  tenantName?: string;
  tenantId?: string;
  catalog?: CatalogUnit[];
};

function PhotoGallery({ photos, alt, height = 'h-52' }: { photos: Array<{ url: string }>; alt: string; height?: string }) {
  const [activePhoto, setActivePhoto] = useState(0);
  const photo = photos[activePhoto] ?? photos[0];

  if (!photo) {
    return <div className={`grid ${height} place-items-center bg-slate-200 text-slate-500`}>Photos coming soon</div>;
  }

  return (
    <div>
      <div className="relative">
        <img src={photo.url} alt={`${alt}, photo ${activePhoto + 1}`} className={`${height} w-full object-cover`} />
        <span className="absolute bottom-3 right-3 rounded-full bg-slate-950/75 px-3 py-1 text-xs font-semibold text-white">
          {activePhoto + 1} / {photos.length}
        </span>
      </div>
      {photos.length > 1 && (
        <div className="grid grid-cols-4 gap-2 bg-slate-100 p-2">
          {photos.slice(0, 4).map((item, index) => (
            <button
              type="button"
              key={`photo-${index}`}
              onClick={() => setActivePhoto(index)}
              aria-label={`View photo ${index + 1}`}
              className={`overflow-hidden rounded-lg ring-2 ${activePhoto === index ? 'ring-emerald-500' : 'ring-transparent'}`}
            >
              <img src={item.url} alt="" className="h-16 w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogCard({
  unit,
  onSchedule,
}: {
  unit: CatalogUnit;
  onSchedule: (unit: CatalogUnit) => void;
}) {
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm">
      <PhotoGallery photos={unit.photos} alt={`${unit.property.name} ${unit.name}`} height="h-44" />
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-lg font-bold">{unit.property.name} — {unit.name}</h3>
        <p className="mt-1 text-xl font-semibold text-emerald-700">
          ${(unit.rentCents / 100).toLocaleString('en-CA')}
          <span className="text-sm font-normal text-slate-500">/month</span>
        </p>
        <ul className="mt-3 space-y-1 text-sm text-slate-600">
          <li>{unit.property.city}, {unit.property.province}</li>
          <li>{unit.bedrooms ?? '—'} bed · {unit.bathrooms ?? '—'} bath{unit.squareFeet ? ` · ${unit.squareFeet.toLocaleString()} sqft` : ''}</li>
          {unit.amenities.length > 0 && <li className="text-slate-500">{unit.amenities.slice(0, 3).join(' · ')}</li>}
        </ul>
        <button
          onClick={() => onSchedule(unit)}
          className="mt-4 w-full rounded-xl bg-slate-900 px-4 py-2.5 font-semibold text-white hover:bg-slate-800"
        >
          View details &amp; schedule
        </button>
      </div>
    </article>
  );
}

function CatalogModal({
  unit,
  contact,
  tenantId,
  onClose,
  onScheduled,
}: {
  unit: CatalogUnit;
  contact: { name: string; phone: string; email: string };
  tenantId?: string;
  onClose: () => void;
  onScheduled: (unit: CatalogUnit) => void;
}) {
  const [slots, setSlots] = useState<Array<{ index: number; startAt: string; label: string }>>([]);
  // Guarda el startAt exacto elegido, no un índice: un índice reindexado
  // contra disponibilidad recién recalculada en el servidor puede apuntar a
  // un hueco distinto del que el prospecto vio y clickeó.
  const [selectedSlot, setSelectedSlot] = useState<string | undefined>();
  const [formContact, setFormContact] = useState(contact);

  const slotsQuery = useQuery({
    queryKey: ['catalog-slots', unit.slug],
    queryFn: () => apiFetch<{ slots: Array<{ index: number; startAt: string; label: string }> }>(`/public/units/${unit.slug}/slots`, {}, tenantId),
    enabled: !!unit.slug,
  });

  useEffect(() => {
    if (slotsQuery.data?.slots) setSlots(slotsQuery.data.slots);
  }, [slotsQuery.data]);

  const scheduleMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/public/units/${unit.slug}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ startAt: selectedSlot, ...formContact }),
      }, tenantId),
    onSuccess: () => onScheduled(unit),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-2xl rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-xl font-bold">{unit.property.name} — {unit.name}</h2>
          <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="Close">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-5">
          <PhotoGallery photos={unit.photos} alt={`${unit.property.name} ${unit.name}`} height="h-56" />

          <div className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div><dt className="text-slate-500">Rent</dt><dd className="font-semibold">${(unit.rentCents / 100).toLocaleString('en-CA')}/mo</dd></div>
            <div><dt className="text-slate-500">Bedrooms</dt><dd className="font-semibold">{unit.bedrooms ?? '—'}</dd></div>
            <div><dt className="text-slate-500">Bathrooms</dt><dd className="font-semibold">{unit.bathrooms ?? '—'}</dd></div>
            <div><dt className="text-slate-500">Sqft</dt><dd className="font-semibold">{unit.squareFeet ? unit.squareFeet.toLocaleString() : '—'}</dd></div>
          </div>

          <div className="mt-4 space-y-2 text-sm text-slate-600">
            <p><strong>Address:</strong> {unit.property.address}, {unit.property.city}, {unit.property.province}</p>
            <p><strong>Pets:</strong> {unit.petPolicy ?? 'Ask about pets'}</p>
            {unit.parking && <p><strong>Parking:</strong> {unit.parking}</p>}
            {unit.utilities && <p><strong>Utilities:</strong> {unit.utilities}</p>}
            {unit.amenities.length > 0 && <p><strong>Amenities:</strong> {unit.amenities.join(', ')}</p>}
            {unit.availableFrom && <p><strong>Available:</strong> {new Date(unit.availableFrom).toLocaleDateString('en-CA')}</p>}
          </div>

          {slotsQuery.isLoading && <p className="mt-5 text-slate-500">Loading tour times…</p>}

          {slotsQuery.isError && (
            <div role="alert" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
              Online booking isn't available right now — we'll follow up to confirm a time.
            </div>
          )}

          {slots.length > 0 && (
            <form
              onSubmit={(e) => { e.preventDefault(); if (selectedSlot !== undefined) scheduleMutation.mutate(); }}
              className="mt-6 border-t border-slate-200 pt-5"
            >
              <h3 className="text-lg font-bold">Choose a tour time</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {slots.map((slot) => (
                  <button
                    type="button"
                    key={slot.startAt}
                    onClick={() => setSelectedSlot(slot.startAt)}
                    className={`rounded-xl border p-3 text-left text-sm ${selectedSlot === slot.startAt ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200' : 'border-slate-300 hover:border-emerald-500'}`}
                  >
                    {selectedSlot === slot.startAt ? '✓ ' : ''}{slot.label}
                  </button>
                ))}
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <input required placeholder="Name" value={formContact.name} onChange={(e) => setFormContact({ ...formContact, name: e.target.value })} className="rounded-xl border border-slate-300 px-4 py-2.5" />
                <input required type="tel" placeholder="Phone" value={formContact.phone} onChange={(e) => setFormContact({ ...formContact, phone: e.target.value })} className="rounded-xl border border-slate-300 px-4 py-2.5" />
                <input required type="email" placeholder="Email" value={formContact.email} onChange={(e) => setFormContact({ ...formContact, email: e.target.value })} className="rounded-xl border border-slate-300 px-4 py-2.5 sm:col-span-2" />
              </div>

              <button disabled={selectedSlot === undefined || scheduleMutation.isPending} className="mt-5 w-full rounded-xl bg-emerald-600 px-5 py-3.5 font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                {scheduleMutation.isPending ? 'Scheduling…' : 'Confirm tour'}
              </button>
              {scheduleMutation.isError && <p className="mt-3 text-red-700">We couldn't schedule that time. Please try another option.</p>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export function ShortlistPage() {
  const { token = '' } = useParams();
  const [selected, setSelected] = useState<string>();
  // Guarda el startAt exacto del hueco elegido, no un índice: reindexar
  // contra disponibilidad recalculada en el servidor puede apuntar a un
  // hueco distinto del que el prospecto vio y clickeó (Finding 1).
  const [selectedSlot, setSelectedSlot] = useState<string>();
  const [confirmed, setConfirmed] = useState('');
  const [confirmedUnit, setConfirmedUnit] = useState('');
  const [confirmedAddress, setConfirmedAddress] = useState('');
  const [contact, setContact] = useState({ name: '', phone: '', email: '', notes: '' });
  const [catalogCity, setCatalogCity] = useState('');
  const [catalogBedrooms, setCatalogBedrooms] = useState('');
  const [catalogBudget, setCatalogBudget] = useState('');
  const [modalUnit, setModalUnit] = useState<CatalogUnit | null>(null);
  const bookingRef = useRef<HTMLElement>(null);

  const { data, isLoading } = useQuery<Shortlist>({
    queryKey: ['shortlist', token],
    queryFn: () => apiFetch(`/public/shortlists/${token}`),
  });

  useEffect(() => {
    setSelected(undefined);
    setSelectedSlot(undefined);
    setConfirmed('');
    setConfirmedUnit('');
    setConfirmedAddress('');
    setContact({ name: '', phone: '', email: '', notes: '' });
  }, [token]);

  useEffect(() => {
    if (!data) return;
    setSelected(data.selectedUnitId);
    setContact((current) => ({ ...current, ...data.contact }));
  }, [data]);

  // Solo registra la selección del lado del servidor; NO depende de que la
  // disponibilidad de horarios también funcione. Antes ambos pasos vivían en
  // un mismo mutationFn, así que si el GET de horarios fallaba (503, sin
  // calendario conectado — el estado normal el día uno de este feature),
  // onSuccess nunca corría y el prospecto que clickeaba "Choose this
  // property" no veía ni el check de selección ni ningún mensaje (Finding 3).
  const selectMutation = useMutation({
    mutationFn: (unitId: string) =>
      apiFetch(`/public/shortlists/${token}/select`, {
        method: 'POST',
        body: JSON.stringify({ unitId }),
      }),
    onSuccess: (_result, unitId) => {
      setSelected(unitId);
      setSelectedSlot(undefined);
      requestAnimationFrame(() =>
        bookingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    },
  });

  const slotsQuery = useQuery({
    queryKey: ['shortlist-slots', token, selected],
    queryFn: () => apiFetch<{ slots: Array<{ index: number; startAt: string; label: string }> }>(
      `/public/shortlists/${token}/slots`,
    ),
    enabled: !!selected,
  });
  const slots = slotsQuery.data?.slots ?? [];

  const schedule = useMutation({
    mutationFn: () =>
      apiFetch<{ scheduledAt: string; unitLabel: string; unitAddress: string }>(
        `/public/shortlists/${token}/schedule`,
        {
          method: 'POST',
          body: JSON.stringify({ startAt: selectedSlot, ...contact }),
        },
      ),
    onSuccess: (result) => {
      setConfirmed(result.scheduledAt);
      setConfirmedUnit(result.unitLabel);
      setConfirmedAddress(result.unitAddress);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  });

  const submitBooking = (event: FormEvent) => {
    event.preventDefault();
    if (selectedSlot !== undefined) schedule.mutate();
  };

  const catalogCities = useMemo(() => {
    const cities = new Set<string>();
    data?.catalog?.forEach((unit) => cities.add(unit.property.city));
    return [...cities].sort();
  }, [data]);

  const filteredCatalog = useMemo(() => {
    if (!data?.catalog) return [];
    return data.catalog.filter((unit) => {
      if (catalogCity && !unit.property.city.toLowerCase().includes(catalogCity.toLowerCase())) return false;
      if (catalogBedrooms) {
        const requested = Number.parseInt(catalogBedrooms.replace('+', ''), 10);
        const isMinimum = catalogBedrooms.endsWith('+');
        if (!Number.isNaN(requested)) {
          if (isMinimum) { if (unit.bedrooms === null || unit.bedrooms < requested) return false; }
          else if (unit.bedrooms !== requested) return false;
        }
      }
      if (catalogBudget) {
        const cents = Number.parseFloat(catalogBudget) * 100;
        if (!Number.isNaN(cents) && unit.rentCents > cents) return false;
      }
      return true;
    });
  }, [data, catalogCity, catalogBedrooms, catalogBudget]);

  if (isLoading) return <main className="grid min-h-screen place-items-center">Loading your matches…</main>;
  if (!data) return <main className="grid min-h-screen place-items-center">This shortlist is unavailable.</main>;

  const selectedUnit = data.units.find((unit) => unit.id === selected);
  const selectedOption = data.units.findIndex((unit) => unit.id === selected) + 1;
  const selectedSlotLabel = slots.find((slot) => slot.startAt === selectedSlot)?.label;

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10">
      <div className="mx-auto max-w-6xl">
        {confirmed && (
          <div role="status" className="mb-8 rounded-2xl border border-emerald-300 bg-emerald-100 p-6 text-emerald-950 shadow-sm">
            <p className="text-xl font-bold">✓ Your tour is confirmed</p>
            <p className="mt-2">
              <strong>{confirmedUnit}</strong><br />
              {confirmedAddress}<br />
              Scheduled for {new Date(confirmed).toLocaleString()}. We also sent the confirmation to your conversation.
            </p>
          </div>
        )}

        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-700">
          {data.tenantName ?? 'Property Management'}
        </p>
        <h1 className="mt-2 text-4xl font-bold">Your best matches</h1>
        <p className="mt-3 text-slate-600">Review the photos and details, then choose a property to see tour times.</p>

        {/* SECCIÓN 1: Opciones preseleccionadas */}
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {data.units.map((unit, index) => (
            <article key={unit.id} className={`overflow-hidden rounded-2xl bg-white shadow-sm ring-2 ${selected === unit.id ? 'ring-emerald-500' : 'ring-transparent'}`}>
              <PhotoGallery photos={unit.photos} alt={`${unit.property.name} ${unit.name}`} />
              <div className="p-5">
                <p className="font-semibold text-emerald-700">Option {index + 1}{index === 0 ? ' · Best match' : ''}</p>
                <h2 className="mt-1 text-xl font-bold">{unit.property.name} — {unit.name}</h2>
                <p className="mt-2 text-2xl font-semibold">
                  ${(unit.rentCents / 100).toLocaleString('en-CA')}
                  <span className="text-sm font-normal text-slate-500">/month</span>
                </p>
                <ul className="mt-4 space-y-1 text-slate-600">
                  <li>{unit.property.city}</li>
                  <li>{unit.bedrooms ?? '—'} bedrooms · {unit.bathrooms ?? '—'} bathrooms</li>
                  <li>{unit.petPolicy ?? 'Ask about pets'}</li>
                </ul>
                <button
                  disabled={selectMutation.isPending}
                  onClick={() => selectMutation.mutate(unit.id)}
                  className={`mt-5 w-full rounded-xl px-4 py-3 font-semibold text-white disabled:opacity-60 ${selected === unit.id ? 'bg-emerald-600' : 'bg-slate-900'}`}
                >
                  {selected === unit.id ? '✓ Selected — view tour times' : 'Choose this property'}
                </button>
              </div>
            </article>
          ))}
        </div>

        {/* Sección de booking para opciones preseleccionadas */}
        {selectedUnit && !confirmed && (
          <section ref={bookingRef} className="mt-10 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">You're scheduling a tour for</p>
              <h2 className="mt-1 text-2xl font-bold">Option {selectedOption}: {selectedUnit.property.name} — {selectedUnit.name}</h2>
              <p className="mt-2 text-slate-700">
                {selectedUnit.property.city}, {selectedUnit.property.province} · ${(selectedUnit.rentCents / 100).toLocaleString('en-CA')}/month
              </p>
            </div>

            {slotsQuery.isLoading && <p className="mt-6 text-slate-500">Loading tour times…</p>}

            {/* No es un caso raro: es el estado por defecto de cualquier
                tenant hasta que un PM conecta su calendario, así que el
                prospecto necesita una explicación honesta, no silencio. */}
            {slotsQuery.isError && (
              <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
                Online booking isn't available right now — we'll follow up to confirm a time.
              </div>
            )}

            {slots.length > 0 && (
              <>
                <h3 className="mt-7 text-2xl font-bold">1. Choose a tour time</h3>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {slots.map((slot) => (
                    <button
                      type="button"
                      key={slot.startAt}
                      onClick={() => setSelectedSlot(slot.startAt)}
                      className={`rounded-xl border p-4 text-left ${selectedSlot === slot.startAt ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200' : 'border-slate-300 hover:border-emerald-500'}`}
                    >
                      {selectedSlot === slot.startAt ? '✓ ' : ''}{slot.label}
                    </button>
                  ))}
                </div>

                <form onSubmit={submitBooking} className="mt-8 border-t border-slate-200 pt-7">
                  <h3 className="text-2xl font-bold">2. Confirm your contact details</h3>
                  <div className="mt-5 grid gap-5 sm:grid-cols-2">
                    <label className="font-medium text-slate-800">
                      Name
                      <input required value={contact.name} onChange={(event) => setContact({ ...contact, name: event.target.value })} autoComplete="name" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal" />
                    </label>
                    <label className="font-medium text-slate-800">
                      Phone
                      <input required type="tel" value={contact.phone} onChange={(event) => setContact({ ...contact, phone: event.target.value })} autoComplete="tel" placeholder="+1 604 555 0123" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal" />
                    </label>
                    <label className="font-medium text-slate-800 sm:col-span-2">
                      Email
                      <input required type="email" value={contact.email} onChange={(event) => setContact({ ...contact, email: event.target.value })} autoComplete="email" placeholder="you@example.com" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal" />
                    </label>
                  </div>

                  {selectedSlotLabel && (
                    <p className="mt-5 rounded-xl bg-slate-100 p-4 text-slate-800"><strong>Selected time:</strong> {selectedSlotLabel}</p>
                  )}
                  <button disabled={selectedSlot === undefined || schedule.isPending} className="mt-5 w-full rounded-xl bg-emerald-600 px-5 py-4 text-lg font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                    {schedule.isPending ? 'Scheduling your tour…' : 'Confirm tour'}
                  </button>
                  {schedule.isError && <p className="mt-4 text-red-700">We couldn't schedule that time. Please review your details or choose another option.</p>}
                </form>
              </>
            )}
          </section>
        )}

        {/* SECCIÓN 2: Catálogo completo con buscador */}
        {data.catalog && data.catalog.length > 0 && (
          <section className="mt-16 border-t border-slate-200 pt-12">
            <h2 className="text-3xl font-bold">Explore all available properties</h2>
            <p className="mt-2 text-slate-600">Browse our full catalog. Found a place you like? Schedule a tour directly from here.</p>

            <div className="mt-6 flex flex-wrap gap-4">
              <select value={catalogCity} onChange={(e) => setCatalogCity(e.target.value)} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm">
                <option value="">All cities</option>
                {catalogCities.map((city) => <option key={city} value={city}>{city}</option>)}
              </select>
              <select value={catalogBedrooms} onChange={(e) => setCatalogBedrooms(e.target.value)} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm">
                <option value="">Any bedrooms</option>
                <option value="1">1 bedroom</option>
                <option value="2">2 bedrooms</option>
                <option value="3">3 bedrooms</option>
                <option value="3+">3+ bedrooms</option>
              </select>
              <input type="number" placeholder="Max budget $" value={catalogBudget} onChange={(e) => setCatalogBudget(e.target.value)} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm" />
            </div>

            <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCatalog.map((unit) => (
                <CatalogCard key={unit.id} unit={unit} onSchedule={setModalUnit} />
              ))}
            </div>

            {filteredCatalog.length === 0 && (
              <p className="mt-8 text-center text-slate-500">No properties match your filters. Try widening your search.</p>
            )}
          </section>
        )}

        {modalUnit && (
          <CatalogModal
            unit={modalUnit}
            contact={{ name: contact.name, phone: contact.phone, email: contact.email }}
            tenantId={data.tenantId}
            onClose={() => setModalUnit(null)}
            onScheduled={(unit) => {
              setModalUnit(null);
              setConfirmedUnit(`${unit.property.name} — ${unit.name}`);
              setConfirmedAddress(`${unit.property.address}, ${unit.property.city}, ${unit.property.province}`);
              setConfirmed(new Date().toISOString());
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        )}
      </div>
    </main>
  );
}

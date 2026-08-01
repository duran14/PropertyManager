import { type FormEvent, useEffect, useRef, useState } from 'react';
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

type Shortlist = {
  units: Unit[];
  selectedUnitId?: string;
  contact: { name: string; phone: string; email: string };
};

function PhotoGallery({ unit }: { unit: Unit }) {
  const [activePhoto, setActivePhoto] = useState(0);
  const photo = unit.photos[activePhoto] ?? unit.photos[0];

  if (!photo) {
    return <div className="grid h-52 place-items-center bg-slate-200 text-slate-500">Photos coming soon</div>;
  }

  return (
    <div>
      <div className="relative">
        <img
          src={photo.url}
          alt={`${unit.property.name}, photo ${activePhoto + 1}`}
          className="h-52 w-full object-cover"
        />
        <span className="absolute bottom-3 right-3 rounded-full bg-slate-950/75 px-3 py-1 text-xs font-semibold text-white">
          {activePhoto + 1} / {unit.photos.length}
        </span>
      </div>
      {unit.photos.length > 1 && (
        <div className="grid grid-cols-4 gap-2 bg-slate-100 p-2">
          {unit.photos.slice(0, 4).map((item, index) => (
            <button
              type="button"
              key={`${unit.id}-${index}`}
              onClick={() => setActivePhoto(index)}
              aria-label={`View photo ${index + 1} of ${unit.property.name}`}
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

export function ShortlistPage() {
  const { token = '' } = useParams();
  const [selected, setSelected] = useState<string>();
  const [slots, setSlots] = useState<Array<{ index: number; label: string }>>([]);
  const [selectedSlot, setSelectedSlot] = useState<number>();
  const [confirmed, setConfirmed] = useState('');
  const [confirmedUnit, setConfirmedUnit] = useState('');
  const [confirmedAddress, setConfirmedAddress] = useState('');
  const [contact, setContact] = useState({ name: '', phone: '', email: '', notes: '' });
  const bookingRef = useRef<HTMLElement>(null);

  const { data, isLoading } = useQuery<Shortlist>({
    queryKey: ['shortlist', token],
    queryFn: () => apiFetch(`/public/shortlists/${token}`),
  });

  useEffect(() => {
    setSelected(undefined);
    setSlots([]);
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

  const choose = useMutation({
    mutationFn: async (unitId: string) => {
      await apiFetch(`/public/shortlists/${token}/select`, {
        method: 'POST',
        body: JSON.stringify({ unitId }),
      });
      return apiFetch<{ slots: Array<{ index: number; label: string }> }>(
        `/public/shortlists/${token}/slots`,
      );
    },
    onSuccess: (result, unitId) => {
      setSelected(unitId);
      setSelectedSlot(undefined);
      setSlots(result.slots);
      requestAnimationFrame(() =>
        bookingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    },
  });

  const schedule = useMutation({
    mutationFn: () =>
      apiFetch<{ scheduledAt: string; unitLabel: string; unitAddress: string }>(
        `/public/shortlists/${token}/schedule`,
        {
          method: 'POST',
          body: JSON.stringify({ slotIndex: selectedSlot, ...contact }),
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

  if (isLoading) return <main className="grid min-h-screen place-items-center">Loading your matches…</main>;
  if (!data) return <main className="grid min-h-screen place-items-center">This shortlist is unavailable.</main>;

  const selectedUnit = data.units.find((unit) => unit.id === selected);
  const selectedOption = data.units.findIndex((unit) => unit.id === selected) + 1;
  const selectedSlotLabel = slots.find((slot) => slot.index === selectedSlot)?.label;

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

        <p className="text-sm font-semibold uppercase tracking-widest text-emerald-700">Your rental shortlist</p>
        <h1 className="mt-2 text-4xl font-bold">Compare your best matches</h1>
        <p className="mt-3 text-slate-600">Review the photos and details, then choose a property to see tour times.</p>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {data.units.map((unit, index) => (
            <article key={unit.id} className={`overflow-hidden rounded-2xl bg-white shadow-sm ring-2 ${selected === unit.id ? 'ring-emerald-500' : 'ring-transparent'}`}>
              <PhotoGallery unit={unit} />
              <div className="p-5">
                <p className="font-semibold text-emerald-700">Option {index + 1}</p>
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
                  disabled={choose.isPending}
                  onClick={() => choose.mutate(unit.id)}
                  className={`mt-5 w-full rounded-xl px-4 py-3 font-semibold text-white disabled:opacity-60 ${selected === unit.id ? 'bg-emerald-600' : 'bg-slate-900'}`}
                >
                  {selected === unit.id ? '✓ Selected — view tour times' : 'Choose this property'}
                </button>
              </div>
            </article>
          ))}
        </div>

        {selectedUnit && slots.length > 0 && !confirmed && (
          <section ref={bookingRef} className="mt-10 scroll-mt-6 rounded-2xl bg-white p-6 shadow-sm">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">You’re scheduling a tour for</p>
              <h2 className="mt-1 text-2xl font-bold">Option {selectedOption}: {selectedUnit.property.name} — {selectedUnit.name}</h2>
              <p className="mt-2 text-slate-700">
                {selectedUnit.property.city}, {selectedUnit.property.province} · ${(selectedUnit.rentCents / 100).toLocaleString('en-CA')}/month
              </p>
            </div>

            <h3 className="mt-7 text-2xl font-bold">1. Choose a tour time</h3>
            <p className="mt-2 text-slate-600">Select the time that works best for you.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {slots.map((slot) => (
                <button
                  type="button"
                  key={slot.index}
                  onClick={() => setSelectedSlot(slot.index)}
                  className={`rounded-xl border p-4 text-left ${selectedSlot === slot.index ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200' : 'border-slate-300 hover:border-emerald-500'}`}
                >
                  {selectedSlot === slot.index ? '✓ ' : ''}{slot.label}
                </button>
              ))}
            </div>

            <form onSubmit={submitBooking} className="mt-8 border-t border-slate-200 pt-7">
              <h3 className="text-2xl font-bold">2. Confirm your contact details</h3>
              <p className="mt-2 text-slate-600">We’ll use these details for your tour confirmation.</p>
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
                <label className="font-medium text-slate-800 sm:col-span-2">
                  Notes for the property manager <span className="font-normal text-slate-500">(optional)</span>
                  <textarea value={contact.notes} onChange={(event) => setContact({ ...contact, notes: event.target.value })} rows={4} maxLength={1000} placeholder="Accessibility needs, questions about the property, or anything else we should know." className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal" />
                </label>
              </div>

              {selectedSlotLabel && (
                <p className="mt-5 rounded-xl bg-slate-100 p-4 text-slate-800"><strong>Selected time:</strong> {selectedSlotLabel}</p>
              )}
              <button disabled={selectedSlot === undefined || schedule.isPending} className="mt-5 w-full rounded-xl bg-emerald-600 px-5 py-4 text-lg font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                {schedule.isPending ? 'Scheduling your tour…' : 'Confirm tour'}
              </button>
              {selectedSlot === undefined && <p className="mt-2 text-center text-sm text-slate-500">Choose a tour time before confirming.</p>}
              {schedule.isError && <p className="mt-4 text-red-700">We couldn't schedule that time. Please review your details or choose another option.</p>}
            </form>
          </section>
        )}
      </div>
    </main>
  );
}

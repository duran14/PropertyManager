import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import type { PropertyRecord, TenantOnboardingProfile } from '../lib/types';

const emptyOnboarding = {
  logoUrl: '',
  services: '',
  values: '',
  pricingNotes: '',
  showingPreferences: '',
  petPolicy: '',
  handoffName: '',
  handoffEmail: '',
  handoffPhone: '',
  aiTone: 'Warm, professional, concise, and transparent that it is an AI assistant.',
  aiInstructions: '',
};

const emptyProperty = {
  name: '',
  address: '',
  city: '',
  province: 'BC',
  postalCode: '',
};

const emptyUnit = {
  propertyId: '',
  name: '',
  rent: '',
  bedrooms: '',
  bathrooms: '',
  squareFeet: '',
  availableFrom: '',
  amenities: '',
  petPolicy: '',
  parking: '',
  utilities: '',
  isActive: true,
};

export function PropertiesPage() {
  const queryClient = useQueryClient();
  const [onboarding, setOnboarding] = useState(emptyOnboarding);
  const [property, setProperty] = useState(emptyProperty);
  const [unit, setUnit] = useState(emptyUnit);

  const { data: onboardingData } = useQuery<{ profile: TenantOnboardingProfile | null }>({
    queryKey: ['onboarding'],
    queryFn: () => apiFetch('/onboarding'),
  });

  const { data: propertiesData, isLoading } = useQuery<{ properties: PropertyRecord[] }>({
    queryKey: ['properties'],
    queryFn: () => apiFetch('/properties'),
  });

  const profile = onboardingData?.profile;
  const properties = propertiesData?.properties ?? [];

  const saveOnboarding = useMutation({
    mutationFn: () => apiFetch('/onboarding', {
      method: 'PUT',
      body: JSON.stringify(onboarding),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['onboarding'] }),
  });

  const createProperty = useMutation({
    mutationFn: () => apiFetch('/properties', {
      method: 'POST',
      body: JSON.stringify(property),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['properties'] });
      setProperty(emptyProperty);
    },
  });

  const createUnit = useMutation({
    mutationFn: () => apiFetch(`/properties/${unit.propertyId}/units`, {
      method: 'POST',
      body: JSON.stringify({
        name: unit.name,
        rentCents: Math.round(Number(unit.rent || 0) * 100),
        bedrooms: unit.bedrooms ? Number(unit.bedrooms) : null,
        bathrooms: unit.bathrooms ? Number(unit.bathrooms) : null,
        squareFeet: unit.squareFeet ? Number(unit.squareFeet) : null,
        availableFrom: unit.availableFrom ? new Date(unit.availableFrom).toISOString() : '',
        amenities: unit.amenities,
        petPolicy: unit.petPolicy,
        parking: unit.parking,
        utilities: unit.utilities,
        isActive: unit.isActive,
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['properties'] });
      queryClient.invalidateQueries({ queryKey: ['units'] });
      setUnit(emptyUnit);
    },
  });

  function loadProfile() {
    if (!profile) return;
    setOnboarding({
      logoUrl: profile.logoUrl ?? '',
      services: profile.services.join(', '),
      values: profile.values.join(', '),
      pricingNotes: profile.pricingNotes ?? '',
      showingPreferences: profile.showingPreferences ?? '',
      petPolicy: profile.petPolicy ?? '',
      handoffName: profile.handoffName ?? '',
      handoffEmail: profile.handoffEmail ?? '',
      handoffPhone: profile.handoffPhone ?? '',
      aiTone: profile.aiTone ?? '',
      aiInstructions: profile.aiInstructions ?? '',
    });
  }

  function onSaveOnboarding(event: FormEvent) {
    event.preventDefault();
    saveOnboarding.mutate();
  }

  function onCreateProperty(event: FormEvent) {
    event.preventDefault();
    createProperty.mutate();
  }

  function onCreateUnit(event: FormEvent) {
    event.preventDefault();
    createUnit.mutate();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Properties & Onboarding</h1>
        <p className="text-sm text-slate-500">
          Keep company policies and active listing inventory ready for the leasing assistant.
        </p>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-medium">Company onboarding</h2>
            <p className="text-xs text-slate-500">Business context, policies, and handoff preferences for the bot.</p>
          </div>
          {profile && (
            <button onClick={loadProfile} className="rounded-md border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
              Load saved
            </button>
          )}
        </div>
        <form onSubmit={onSaveOnboarding} className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-3">
          <TextField label="Logo URL" value={onboarding.logoUrl} onChange={(value) => setOnboarding({ ...onboarding, logoUrl: value })} />
          <TextField label="Services" value={onboarding.services} onChange={(value) => setOnboarding({ ...onboarding, services: value })} placeholder="Leasing, tenant screening, maintenance" />
          <TextField label="Company values" value={onboarding.values} onChange={(value) => setOnboarding({ ...onboarding, values: value })} placeholder="Responsive, transparent, compliant" />
          <TextArea label="Pricing notes" value={onboarding.pricingNotes} onChange={(value) => setOnboarding({ ...onboarding, pricingNotes: value })} />
          <TextArea label="Showing preferences" value={onboarding.showingPreferences} onChange={(value) => setOnboarding({ ...onboarding, showingPreferences: value })} />
          <TextArea label="Default pet policy" value={onboarding.petPolicy} onChange={(value) => setOnboarding({ ...onboarding, petPolicy: value })} />
          <TextField label="Handoff name" value={onboarding.handoffName} onChange={(value) => setOnboarding({ ...onboarding, handoffName: value })} />
          <TextField label="Handoff email" value={onboarding.handoffEmail} onChange={(value) => setOnboarding({ ...onboarding, handoffEmail: value })} />
          <TextField label="Handoff phone" value={onboarding.handoffPhone} onChange={(value) => setOnboarding({ ...onboarding, handoffPhone: value })} />
          <TextField label="AI tone" value={onboarding.aiTone} onChange={(value) => setOnboarding({ ...onboarding, aiTone: value })} className="lg:col-span-3" />
          <TextArea label="AI instructions" value={onboarding.aiInstructions} onChange={(value) => setOnboarding({ ...onboarding, aiInstructions: value })} className="lg:col-span-3" />
          <div className="lg:col-span-3">
            <button disabled={saveOnboarding.isPending} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Save onboarding
            </button>
          </div>
        </form>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="font-medium">Add property</h2>
          </div>
          <form onSubmit={onCreateProperty} className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <TextField label="Property name" value={property.name} onChange={(value) => setProperty({ ...property, name: value })} required />
            <TextField label="City" value={property.city} onChange={(value) => setProperty({ ...property, city: value })} required />
            <TextField label="Address" value={property.address} onChange={(value) => setProperty({ ...property, address: value })} className="md:col-span-2" required />
            <TextField label="Province" value={property.province} onChange={(value) => setProperty({ ...property, province: value })} />
            <TextField label="Postal code" value={property.postalCode} onChange={(value) => setProperty({ ...property, postalCode: value })} />
            <div className="md:col-span-2">
              <button disabled={createProperty.isPending} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Create property
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="font-medium">Add unit</h2>
          </div>
          <form onSubmit={onCreateUnit} className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
            <label className="md:col-span-3">
              <span className="mb-1 block text-xs font-medium text-slate-500">Property</span>
              <select value={unit.propertyId} onChange={(event) => setUnit({ ...unit, propertyId: event.target.value })} required className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select property</option>
                {properties.map((propertyRecord) => (
                  <option key={propertyRecord.id} value={propertyRecord.id}>{propertyRecord.name}</option>
                ))}
              </select>
            </label>
            <TextField label="Unit name" value={unit.name} onChange={(value) => setUnit({ ...unit, name: value })} required />
            <TextField label="Rent CAD" value={unit.rent} onChange={(value) => setUnit({ ...unit, rent: value })} type="number" required />
            <TextField label="Available from" value={unit.availableFrom} onChange={(value) => setUnit({ ...unit, availableFrom: value })} type="date" />
            <TextField label="Beds" value={unit.bedrooms} onChange={(value) => setUnit({ ...unit, bedrooms: value })} type="number" />
            <TextField label="Baths" value={unit.bathrooms} onChange={(value) => setUnit({ ...unit, bathrooms: value })} type="number" />
            <TextField label="Sq ft" value={unit.squareFeet} onChange={(value) => setUnit({ ...unit, squareFeet: value })} type="number" />
            <TextField label="Amenities" value={unit.amenities} onChange={(value) => setUnit({ ...unit, amenities: value })} className="md:col-span-3" placeholder="balcony, parking, in-suite laundry" />
            <TextField label="Pet policy" value={unit.petPolicy} onChange={(value) => setUnit({ ...unit, petPolicy: value })} />
            <TextField label="Parking" value={unit.parking} onChange={(value) => setUnit({ ...unit, parking: value })} />
            <TextField label="Utilities" value={unit.utilities} onChange={(value) => setUnit({ ...unit, utilities: value })} />
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={unit.isActive} onChange={(event) => setUnit({ ...unit, isActive: event.target.checked })} />
              Active for chatbot recommendations
            </label>
            <div className="md:col-span-3">
              <button disabled={createUnit.isPending || properties.length === 0} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Create unit
              </button>
            </div>
          </form>
        </section>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="font-medium">Inventory</h2>
        </div>
        <div className="divide-y divide-slate-100">
          {isLoading && <p className="p-4 text-sm text-slate-400">Loading...</p>}
          {!isLoading && properties.length === 0 && <p className="p-4 text-sm text-slate-400">No properties yet.</p>}
          {properties.map((propertyRecord) => (
            <div key={propertyRecord.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-medium text-slate-900">{propertyRecord.name}</h3>
                  <p className="text-sm text-slate-500">{propertyRecord.address}, {propertyRecord.city}, {propertyRecord.province}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{propertyRecord.units.length} units</span>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {propertyRecord.units.map((unitRecord) => (
                  <div key={unitRecord.id} className="rounded-md border border-slate-200 p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">{unitRecord.name}</div>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${unitRecord.isActive ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                        {unitRecord.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-slate-600">${(unitRecord.rentCents / 100).toLocaleString('en-CA')}/month</div>
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-slate-500">
                      {unitRecord.bedrooms !== null && <span className="rounded border border-slate-200 px-1.5 py-0.5">{unitRecord.bedrooms} bed</span>}
                      {unitRecord.bathrooms !== null && <span className="rounded border border-slate-200 px-1.5 py-0.5">{unitRecord.bathrooms} bath</span>}
                      {unitRecord.availableFrom && <span className="rounded border border-slate-200 px-1.5 py-0.5">From {new Date(unitRecord.availableFrom).toLocaleDateString('en-CA')}</span>}
                      {unitRecord.petPolicy && <span className="rounded border border-slate-200 px-1.5 py-0.5">{unitRecord.petPolicy}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  className = '',
  type = 'text',
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className={className}>
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={className}>
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </label>
  );
}

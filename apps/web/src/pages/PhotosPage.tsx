import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import { Icon, type IconName } from '../components/Icon';

interface ListingPhoto {
  id: string;
  originalUrl: string;
  enhancedUrl: string | null;
  enhancementType: string;
  status: string;
  autoenhanceOrderId: string | null;
  isPrimary: boolean;
  createdAt: string;
}

interface Unit {
  id: string;
  name: string;
  property: { name: string; city: string };
}

const ENHANCEMENT_OPTIONS: Array<{ type: 'enhance' | 'object_removal' | 'virtual_staging'; label: string; icon: IconName; desc: string }> = [
  { type: 'enhance', label: 'Mejorar', icon: 'sparkles', desc: 'HDR, iluminación, cielo' },
  { type: 'object_removal', label: 'Quitar objetos', icon: 'document', desc: 'Muebles, cajas, desorden' },
  { type: 'virtual_staging', label: 'Staging virtual', icon: 'home', desc: 'Añadir muebles IA' },
];

const STATUS_STYLES: Record<string, string> = {
  uploaded: 'bg-slate-100 text-slate-600',
  processing: 'bg-amber-100 text-amber-700',
  enhanced: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  uploaded: 'Subida',
  processing: 'Procesando',
  enhanced: 'Mejorada',
  failed: 'Falló',
};

export function PhotosPage({ units }: { units: Unit[] }) {
  const queryClient = useQueryClient();
  const [selectedUnit, setSelectedUnit] = useState<string>(units[0]?.id ?? '');
  const [uploadUrl, setUploadUrl] = useState('');
  const [showBefore, setShowBefore] = useState<Record<string, boolean>>({});

  const { data, isLoading } = useQuery<{ photos: ListingPhoto[] }>({
    queryKey: ['photos', selectedUnit],
    queryFn: () => apiFetch(`/photos/units/${selectedUnit}/photos`),
    enabled: !!selectedUnit,
    refetchInterval: (query) => {
      // Auto-refresh si hay fotos procesándose.
      const photos = query.state.data?.photos ?? [];
      return photos.some((p) => p.status === 'processing') ? 3000 : false;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (input: { originalUrl: string; isPrimary?: boolean }) =>
      apiFetch(`/photos/units/${selectedUnit}/photos`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photos', selectedUnit] });
      setUploadUrl('');
    },
  });

  const enhanceMutation = useMutation({
    mutationFn: ({ photoId, type, style }: { photoId: string; type: string; style?: string }) =>
      apiFetch(`/photos/photos/${photoId}/enhance`, {
        method: 'POST',
        body: JSON.stringify({ enhancementType: type, style }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['photos', selectedUnit] }),
  });

  const photos = data?.photos ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Galería de Fotos IA</h1>
        <p className="text-sm text-slate-500">
          Sube fotos del inmueble y mejóralas con IA: HDR, remoción de objetos, staging virtual.
        </p>
      </div>

      {/* Selector de unidad */}
      <div className="mb-6 flex items-center gap-3">
        <label className="text-sm font-medium text-slate-600">Unidad:</label>
        <select
          value={selectedUnit}
          onChange={(e) => setSelectedUnit(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} · {u.property.name}
            </option>
          ))}
        </select>
      </div>

      {/* Subir foto */}
      <div className="mb-6 bg-white rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium mb-3 text-sm">Subir foto</h2>
        <div className="flex gap-2">
          <input
            type="url"
            value={uploadUrl}
            onChange={(e) => setUploadUrl(e.target.value)}
            placeholder="https://ejemplo.com/foto-original.jpg"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <button
            onClick={() => uploadMutation.mutate({ originalUrl: uploadUrl })}
            disabled={!uploadUrl || uploadMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
          >
            <Icon name="upload" size={16} />
            Subir
          </button>
        </div>
        {uploadMutation.isError && (
          <p className="text-xs text-red-600 mt-2">Error al subir la foto.</p>
        )}
      </div>

      {/* Galería */}
      {isLoading ? (
        <p className="text-slate-400">Cargando fotos...</p>
      ) : photos.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-12 text-center">
          <p className="text-slate-400">Sin fotos. Sube una URL arriba para empezar.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {photos.map((photo) => {
            const showOriginal = showBefore[photo.id] ?? false;
            const displayUrl = photo.enhancedUrl && !showOriginal ? photo.enhancedUrl : photo.originalUrl;
            return (
              <div key={photo.id} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                {/* Imagen */}
                <div className="relative aspect-[4/3] bg-slate-100">
                  <img
                    src={displayUrl}
                    alt="Property"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  {/* Badge de estado */}
                  <span className={`absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[photo.status] ?? 'bg-slate-100'}`}>
                    {STATUS_LABELS[photo.status] ?? photo.status}
                  </span>
                  {photo.isPrimary && (
                    <span className="absolute top-2 right-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
                      Principal
                    </span>
                  )}
                  {/* Toggle before/after */}
                  {photo.enhancedUrl && (
                    <button
                      onClick={() => setShowBefore((s) => ({ ...s, [photo.id]: !s[photo.id] }))}
                      className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-xs text-white hover:bg-black/80"
                    >
                      {showOriginal ? 'Ver mejorada' : 'Ver original'}
                    </button>
                  )}
                </div>

                {/* Acciones */}
                <div className="p-3">
                  {photo.status === 'uploaded' && (
                    <div className="flex gap-1.5">
                      {ENHANCEMENT_OPTIONS.map((opt) => (
                        <button
                          key={opt.type}
                          onClick={() => enhanceMutation.mutate({ photoId: photo.id, type: opt.type })}
                          disabled={enhanceMutation.isPending}
                          title={opt.desc}
                          className="flex-1 inline-flex flex-col items-center gap-0.5 rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-600 hover:bg-violet-50 hover:text-violet-700"
                        >
                          <Icon name={opt.icon} size={14} />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {photo.status === 'processing' && (
                    <p className="text-xs text-amber-600 text-center py-1">⏳ Procesando con IA...</p>
                  )}
                  {photo.status === 'enhanced' && (
                    <p className="text-xs text-green-600 text-center py-1">
                      ✓ {photo.enhancementType.replace('_', ' ')}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

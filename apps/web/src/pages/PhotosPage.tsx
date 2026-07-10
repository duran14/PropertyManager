import { useEffect, useState } from 'react';
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
  { type: 'enhance', label: 'Enhance', icon: 'sparkles', desc: 'HDR, lighting, sky replacement' },
  { type: 'object_removal', label: 'Clean up', icon: 'document', desc: 'Remove furniture, boxes, or clutter' },
  { type: 'virtual_staging', label: 'Stage', icon: 'home', desc: 'Add AI-generated furniture' },
];

const STATUS_STYLES: Record<string, string> = {
  uploaded: 'bg-slate-100 text-slate-600',
  processing: 'bg-amber-100 text-amber-700',
  enhanced: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  uploaded: 'Uploaded',
  processing: 'Processing',
  enhanced: 'Enhanced',
  failed: 'Failed',
};

export function PhotosPage({ units }: { units: Unit[] }) {
  const queryClient = useQueryClient();
  const [selectedUnit, setSelectedUnit] = useState<string>(units[0]?.id ?? '');
  const [uploadUrl, setUploadUrl] = useState('');
  const [showBefore, setShowBefore] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!selectedUnit && units[0]) {
      setSelectedUnit(units[0].id);
    }
  }, [selectedUnit, units]);

  const { data, isLoading } = useQuery<{ photos: ListingPhoto[] }>({
    queryKey: ['photos', selectedUnit],
    queryFn: () => apiFetch(`/photos/units/${selectedUnit}/photos`),
    enabled: !!selectedUnit,
    refetchInterval: (query) => {
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
        <h1 className="text-2xl font-bold">AI Photo Gallery</h1>
        <p className="text-sm text-slate-500">
          Upload listing photos and enhance them with AI: HDR, object removal, and virtual staging.
        </p>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <label className="text-sm font-medium text-slate-600">Unit:</label>
        <select
          value={selectedUnit}
          onChange={(e) => setSelectedUnit(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} / {u.property.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-6 bg-white rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium mb-3 text-sm">Upload photo</h2>
        <div className="flex gap-2">
          <input
            type="url"
            value={uploadUrl}
            onChange={(e) => setUploadUrl(e.target.value)}
            placeholder="https://example.com/original-photo.jpg"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <button
            onClick={() => uploadMutation.mutate({ originalUrl: uploadUrl })}
            disabled={!uploadUrl || uploadMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
          >
            <Icon name="upload" size={16} />
            Upload
          </button>
        </div>
        {uploadMutation.isError && <p className="text-xs text-red-600 mt-2">Unable to upload the photo.</p>}
      </div>

      {isLoading ? (
        <p className="text-slate-400">Loading photos...</p>
      ) : photos.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-12 text-center">
          <p className="text-slate-400">No photos yet. Add a URL above to start.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {photos.map((photo) => {
            const showOriginal = showBefore[photo.id] ?? false;
            const displayUrl = photo.enhancedUrl && !showOriginal ? photo.enhancedUrl : photo.originalUrl;
            return (
              <div key={photo.id} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <div className="relative aspect-[4/3] bg-slate-100">
                  <img
                    src={displayUrl}
                    alt="Property"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <span className={`absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[photo.status] ?? 'bg-slate-100'}`}>
                    {STATUS_LABELS[photo.status] ?? photo.status}
                  </span>
                  {photo.isPrimary && (
                    <span className="absolute top-2 right-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
                      Primary
                    </span>
                  )}
                  {photo.enhancedUrl && (
                    <button
                      onClick={() => setShowBefore((s) => ({ ...s, [photo.id]: !s[photo.id] }))}
                      className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-xs text-white hover:bg-black/80"
                    >
                      {showOriginal ? 'View enhanced' : 'View original'}
                    </button>
                  )}
                </div>

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
                    <p className="text-xs text-amber-600 text-center py-1">Processing with AI...</p>
                  )}
                  {photo.status === 'enhanced' && (
                    <p className="text-xs text-green-600 text-center py-1">
                      {photo.enhancementType.replace('_', ' ')}
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

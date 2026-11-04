'use client';
// Up to 6 photos per area: take or pick, saved on the phone at once, uploaded on sync. Photos
// already on the server (taken on another device) are shown too.
import { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '@/lib/offline/db';
import { addAreaPhoto, removeAreaPhoto, type LocalPhoto } from '@/lib/offline/photos';
import { MAX_PHOTOS_PER_AREA, type RemotePhoto } from '@/lib/photos/rules';
import { Badge, Button } from '@/components/ui';
import { useLive, useOnline } from '../hooks';

interface Shown {
  id: string;
  thumb: string;
  full: string;
  status: 'phone' | 'uploaded' | 'error';
  error?: string | null;
}

/** The estimate's photos on the server, fetched once per estimate while online. */
export function useRemotePhotos(estimateId: string): { photos: RemotePhoto[]; reload: () => void } {
  const online = useOnline();
  const [photos, setPhotos] = useState<RemotePhoto[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!online) return;
    let live = true;
    fetch(`/api/photos?estimateId=${estimateId}`)
      .then((r) => (r.ok ? r.json() : { photos: [] }))
      .then((b: { photos: RemotePhoto[] }) => live && setPhotos(b.photos ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [estimateId, online, tick]);
  return { photos, reload: () => setTick((t) => t + 1) };
}

export function AreaPhotos({ estimateId, areaId, ownerId, remote, onRemoteDeleted }: { estimateId: string; areaId: string; ownerId: string; remote: RemotePhoto[]; onRemoteDeleted: () => void }) {
  const local = useLive(() => db().photos.where('areaId').equals(areaId).toArray(), [areaId], [] as LocalPhoto[]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Shown | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  // Object URLs for the phone's copies; freed when the list changes.
  const localShown = useMemo(
    () =>
      local
        .filter((p) => p.state !== 'deleting')
        .sort((a, b) => a.takenAt.localeCompare(b.takenAt))
        .map((p): Shown => ({ id: p.id, thumb: URL.createObjectURL(p.thumb), full: URL.createObjectURL(p.blob), status: p.lastError ? 'error' : p.state === 'uploaded' ? 'uploaded' : 'phone', error: p.lastError })),
    [local],
  );
  useEffect(() => () => localShown.forEach((s) => (URL.revokeObjectURL(s.thumb), URL.revokeObjectURL(s.full))), [localShown]);

  const known = new Set(local.map((p) => p.id));
  const shown = [...localShown, ...remote.filter((r) => r.areaId === areaId && !known.has(r.id)).map((r): Shown => ({ id: r.id, thumb: r.url, full: r.url, status: 'uploaded' }))];
  const left = MAX_PHOTOS_PER_AREA - shown.length;

  const add = async (files: FileList | null) => {
    const list = [...(files ?? [])].slice(0, Math.max(left, 0));
    if (!list.length) return;
    setError(files && files.length > left ? `Only ${left} more fit (max ${MAX_PHOTOS_PER_AREA}).` : null);
    for (const [i, f] of list.entries()) {
      setBusy(`Saving ${i + 1} of ${list.length}…`);
      try {
        await addAreaPhoto(f, estimateId, areaId, ownerId);
      } catch (e) {
        setError((e as Error).message);
      }
    }
    setBusy(null);
  };

  const remove = async (s: Shown) => {
    if (known.has(s.id)) await removeAreaPhoto(s.id);
    else {
      const res = await fetch(`/api/photos?id=${s.id}`, { method: 'DELETE' }).catch(() => null);
      if (!res?.ok) return setError('Could not delete it. Try again when you have signal.');
      onRemoteDeleted();
    }
    setViewing(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">Photos</span>
        <span className="text-xs text-slate-500">
          {shown.length}/{MAX_PHOTOS_PER_AREA}
        </span>
      </div>
      {shown.length ? (
        <div className="grid grid-cols-3 gap-2">
          {shown.map((s) => (
            <button key={s.id} type="button" onClick={() => setViewing(s)} className="relative aspect-square overflow-hidden rounded-xl ring-1 ring-slate-300" aria-label="Open photo">
              {/* eslint-disable-next-line @next/next/no-img-element -- blob: and signed URLs */}
              <img src={s.thumb} alt="" className="h-full w-full object-cover" />
              {s.status !== 'uploaded' ? (
                <span className="absolute bottom-1 left-1">
                  <Badge tone={s.status === 'error' ? 'red' : 'amber'}>{s.status === 'error' ? 'Not uploaded' : 'On phone'}</Badge>
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {left > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void add(e.target.files).then(() => (e.target.value = ''))} />
          <input ref={library} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void add(e.target.files).then(() => (e.target.value = ''))} />
          <Button variant="secondary" disabled={busy !== null} onClick={() => camera.current?.click()}>
            📷 Take photo
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => library.current?.click()}>
            🖼 Choose
          </Button>
        </div>
      ) : null}
      {busy || error ? <p className="text-sm text-slate-600">{busy ?? error}</p> : null}

      {viewing ? (
        <div role="dialog" aria-modal="true" aria-label="Photo" className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3" onClick={() => setViewing(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing.full} alt="" className="min-h-0 flex-1 object-contain" />
          {viewing.error ? <p className="mt-2 text-center text-sm text-red-200">Upload problem: {viewing.error}</p> : null}
          <div className="mt-3 grid grid-cols-2 gap-2" onClick={(e) => e.stopPropagation()}>
            <Button variant="danger" onClick={() => void remove(viewing)}>
              Delete
            </Button>
            <Button onClick={() => setViewing(null)}>Close</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

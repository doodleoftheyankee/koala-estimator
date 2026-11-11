'use client';
// Area photos on the phone: shrink on capture, keep in IndexedDB, upload once the estimate and
// its area are on the server, and delete everywhere. Works offline; sync catches up later.
import { areaSchema } from '@/lib/sync/draft';
import { MAX_PHOTO_BYTES } from '@/lib/photos/rules';
import { db, type LocalPhoto } from './db';

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that photo. Is it an image?"));
    };
    img.src = url;
  });
}

function resize(img: HTMLImageElement, maxSide: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve({ blob: b, width: canvas.width, height: canvas.height }) : reject(new Error('Could not compress the photo.'))), 'image/jpeg', quality),
  );
}

/** A smaller JPEG copy of a stored photo, e.g. for AI reading (which works at ~1568px). */
export async function shrinkPhoto(blob: Blob, maxSide: number, quality = 0.8): Promise<Blob> {
  return (await resize(await loadImage(blob), maxSide, quality)).blob;
}

/** Saves a photo for an area on this phone (a 2000px copy + a 320px thumbnail). Upload happens on sync. */
export async function addAreaPhoto(file: File, estimateId: string, areaId: string, ownerId: string): Promise<void> {
  const img = await loadImage(file);
  let full = await resize(img, 2000, 0.82);
  if (full.blob.size > MAX_PHOTO_BYTES) full = await resize(img, 1400, 0.7);
  const thumb = await resize(img, 320, 0.7);
  await db().photos.put({
    id: crypto.randomUUID(),
    estimateId,
    areaId,
    ownerId,
    takenAt: new Date(file.lastModified || Date.now()).toISOString(),
    blob: full.blob,
    thumb: thumb.blob,
    width: full.width,
    height: full.height,
    state: 'pending',
    lastError: null,
  });
}

/** Deletes a photo: right away if it never left the phone, otherwise after the server deletes it. */
export async function removeAreaPhoto(id: string): Promise<void> {
  const photo = await db().photos.get(id);
  if (!photo) return;
  if (photo.state === 'pending') await db().photos.delete(id);
  else await db().photos.update(id, { state: 'deleting', lastError: null });
}

/** Deletes every photo of an area (the area was removed from the estimate). */
export async function removeAreaPhotos(areaId: string): Promise<void> {
  const photos = await db().photos.where('areaId').equals(areaId).toArray();
  await Promise.all(photos.map((p) => removeAreaPhoto(p.id)));
}

/**
 * Uploads pending photos and sends pending deletes. A photo waits until its estimate has synced
 * and its area is complete (so the area exists on the server); failures retry next sync.
 */
export async function syncPhotos(): Promise<void> {
  const work = await db().photos.where('state').anyOf('pending', 'deleting').toArray();
  for (const p of work) {
    if (!navigator.onLine) return;
    if (p.state === 'deleting') {
      const res = await fetch(`/api/photos?id=${p.id}`, { method: 'DELETE' }).catch(() => null);
      if (res?.ok) await db().photos.delete(p.id);
      continue;
    }
    const est = await db().estimates.get(p.estimateId);
    if (!est || est.syncState !== 'synced') continue;
    const area = est.draft.areas.find((a) => a.id === p.areaId);
    if (!area || !areaSchema.safeParse(area).success) continue;
    const form = new FormData();
    form.set('id', p.id);
    form.set('estimateId', p.estimateId);
    form.set('areaId', p.areaId);
    form.set('takenAt', p.takenAt);
    form.set('width', String(p.width));
    form.set('height', String(p.height));
    form.set('file', p.blob, `${p.id}.jpg`);
    const res = await fetch('/api/photos', { method: 'POST', body: form }).catch(() => null);
    if (res?.ok) await db().photos.update(p.id, { state: 'uploaded', lastError: null });
    else if (res) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      await db().photos.update(p.id, { lastError: body.error ?? `Upload failed (${res.status})` });
    }
  }
}

export type { LocalPhoto };

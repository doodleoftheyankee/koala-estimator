'use client';
// Asks the server to read an area's photos with AI (app/api/photos/read) and reports what the
// estimator did with each suggestion. Needs a connection; nothing here is queued.
import { MAX_READ_PHOTOS, MAX_READ_TOTAL_BYTES, READ_PHOTO_MAX_SIDE, type PhotoRead, type ReadContext } from '@/lib/ai/photoRead';
import type { RemotePhoto } from '@/lib/photos/rules';
import type { LocalPhoto } from './db';
import { shrinkPhoto } from './photos';

export interface ReadResponse {
  read: PhotoRead;
  analysisId: string | null;
  model: string;
  createdAt: string;
}

export class ReadFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

let configured: Promise<boolean> | null = null;
/** Whether the server has AI reading switched on (asked once per app load). */
export function photoReadAvailable(): Promise<boolean> {
  configured ??= fetch('/api/photos/read')
    .then((r) => (r.ok ? r.json() : { configured: true }))
    .then((b: { configured?: boolean }) => b.configured !== false)
    .catch(() => {
      configured = null; // offline: ask again next time
      return true;
    });
  return configured;
}

/**
 * Sends up to 6 photos (phone copies shrunk to the size the model reads at, plus ids of photos
 * already on the server) with the area details, and waits for the read (usually 20–60 seconds).
 */
export async function requestPhotoRead(ctx: ReadContext, local: LocalPhoto[], remote: RemotePhoto[], signal?: AbortSignal): Promise<ReadResponse & { photoIds: string[] }> {
  const form = new FormData();
  form.set('context', JSON.stringify(ctx));
  const photoIds: string[] = [];
  let total = 0;
  for (const p of local.slice(0, MAX_READ_PHOTOS)) {
    let blob = await shrinkPhoto(p.blob, READ_PHOTO_MAX_SIDE, 0.8);
    if (total + blob.size > MAX_READ_TOTAL_BYTES) blob = await shrinkPhoto(p.blob, 1100, 0.7);
    if (total + blob.size > MAX_READ_TOTAL_BYTES) break;
    total += blob.size;
    form.append('photo', blob, `${p.id}.jpg`);
    form.append('photoId', p.id);
    photoIds.push(p.id);
  }
  for (const r of remote.slice(0, MAX_READ_PHOTOS - photoIds.length)) {
    form.append('remotePhotoId', r.id);
    photoIds.push(r.id);
  }
  if (!photoIds.length) throw new ReadFailed('Add a photo first.', 'invalid');

  let res: Response;
  try {
    res = await fetch('/api/photos/read', { method: 'POST', body: form, signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ReadFailed('Stopped.', 'aborted');
    throw new ReadFailed(navigator.onLine ? "Couldn't reach the server. Try again." : 'No signal. Reading photos needs a connection.', 'unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<ReadResponse> & { error?: string; code?: string };
  if (!res.ok || !body.read) throw new ReadFailed(body.error ?? `The photo read failed (${res.status}).`, body.code ?? 'failed');
  return { read: body.read, analysisId: body.analysisId ?? null, model: body.model ?? '', createdAt: body.createdAt ?? new Date().toISOString(), photoIds };
}

/** Records applied/dismissed suggestions for calibration. Best effort: a lost report changes nothing on the estimate. */
export function sendReadFeedback(analysisId: string | null, decisions: Array<{ field: string; aiValue: string | null; confirmedValue: string | null; accepted: boolean }>): void {
  if (!analysisId || !decisions.length || !navigator.onLine) return;
  void fetch('/api/photos/read', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysisId, decisions }),
  }).catch(() => undefined);
}

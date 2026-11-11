'use client';
// Asks the server to read an area's photos with AI (app/api/photos/read) and reports what the
// estimator did with each suggestion. Needs a connection; nothing here is queued.
//
// A read keeps going when the estimator closes the area or moves to another step: reads in
// flight live here (one per area), and a result that arrives while no card is showing waits here
// until the card for that area shows again. Only Stop cancels a read.
import { MAX_READ_PHOTOS, MAX_READ_TOTAL_BYTES, READ_PHOTO_MAX_SIDE, type PhotoRead, type ReadContext } from '@/lib/ai/photoRead';
import type { RemotePhoto } from '@/lib/photos/rules';
import type { LocalPhoto } from './db';
import { shrinkPhoto } from './photos';

export interface ReadResponse {
  read: PhotoRead;
  analysisId: string | null;
  model: string;
  createdAt: string;
  /** The photos actually read, in the order the answer numbers them. */
  photoIds: string[];
}

export class ReadFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type ReadOutcome = { ok: true; response: ReadResponse } | { ok: false; error: ReadFailed };

let configured: Promise<boolean> | null = null;
/** Whether the server has AI reading switched on. Only a "yes" is remembered, so fixing the key works without reloading. */
export function photoReadAvailable(): Promise<boolean> {
  configured ??= fetch('/api/photos/read')
    .then((r) => (r.ok ? r.json() : { configured: true }))
    .then((b: { configured?: boolean }) => {
      const ok = b.configured !== false;
      if (!ok) configured = null;
      return ok;
    })
    .catch(() => {
      configured = null; // offline: ask again next time
      return true;
    });
  return configured;
}

interface InFlight {
  promise: Promise<ReadOutcome>;
  controller: AbortController;
  startedAt: number;
  photoCount: number;
}
const inFlight = new Map<string, InFlight>();
const finished = new Map<string, ReadOutcome>();
const listeners = new Set<(areaId: string) => void>();

/** The read running for an area, if any. */
export const runningRead = (areaId: string): InFlight | undefined => inFlight.get(areaId);
/** Takes a result that finished while no card for the area was showing. */
export function takeFinishedRead(areaId: string): ReadOutcome | undefined {
  const r = finished.get(areaId);
  finished.delete(areaId);
  return r;
}
/** Called with an area id whenever a read for it finishes. */
export function onReadFinished(fn: (areaId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Starts a read for an area (or returns the one already running). */
export function startPhotoRead(ctx: ReadContext, local: LocalPhoto[], remote: RemotePhoto[]): InFlight {
  const running = inFlight.get(ctx.areaId);
  if (running) return running;
  const controller = new AbortController();
  const photoCount = Math.min(MAX_READ_PHOTOS, local.length + remote.length);
  const promise: Promise<ReadOutcome> = requestPhotoRead(ctx, local, remote, controller.signal)
    .then((response): ReadOutcome => ({ ok: true, response }))
    .catch((e): ReadOutcome => ({ ok: false, error: e instanceof ReadFailed ? e : new ReadFailed('The photo read failed. Try again.', 'failed') }))
    .then((outcome) => {
      inFlight.delete(ctx.areaId);
      finished.set(ctx.areaId, outcome);
      listeners.forEach((fn) => fn(ctx.areaId));
      return outcome;
    });
  const entry = { promise, controller, startedAt: Date.now(), photoCount };
  inFlight.set(ctx.areaId, entry);
  return entry;
}

/**
 * Sends up to 6 photos (phone copies shrunk to the size the model reads at, plus ids of photos
 * already on the server) with the area details, and waits for the read (usually 20–60 seconds).
 */
async function requestPhotoRead(ctx: ReadContext, local: LocalPhoto[], remote: RemotePhoto[], signal: AbortSignal): Promise<ReadResponse> {
  const form = new FormData();
  form.set('context', JSON.stringify(ctx));
  let sent = 0;
  let total = 0;
  for (const p of local.slice(0, MAX_READ_PHOTOS)) {
    let blob = await shrinkPhoto(p.blob, READ_PHOTO_MAX_SIDE, 0.8);
    if (total + blob.size > MAX_READ_TOTAL_BYTES) blob = await shrinkPhoto(p.blob, 1100, 0.7);
    if (total + blob.size > MAX_READ_TOTAL_BYTES) break;
    total += blob.size;
    form.append('photo', blob, `${p.id}.jpg`);
    form.append('photoId', p.id);
    sent++;
  }
  for (const r of remote.slice(0, MAX_READ_PHOTOS - sent)) {
    form.append('remotePhotoId', r.id);
    sent++;
  }
  if (!sent) throw new ReadFailed('Add a photo first.', 'invalid');

  let res: Response;
  try {
    res = await fetch('/api/photos/read', { method: 'POST', body: form, signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ReadFailed('Stopped.', 'aborted');
    throw new ReadFailed(navigator.onLine ? "Couldn't reach the server. Try again." : 'No signal. Reading photos needs a connection.', 'unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<ReadResponse> & { error?: string; code?: string };
  if (!res.ok || !body.read) {
    const timedOut = res.status === 504 && !body.error;
    throw new ReadFailed(body.error ?? (timedOut ? 'The AI took too long. Try again with fewer photos.' : `The photo read failed (${res.status}). Try again.`), body.code ?? 'failed');
  }
  return { read: body.read, analysisId: body.analysisId ?? null, model: body.model ?? '', createdAt: body.createdAt ?? new Date().toISOString(), photoIds: body.photoIds ?? [] };
}

/** Records applied/skipped suggestions for calibration. Best effort: a lost report changes nothing on the estimate. */
export function sendReadFeedback(analysisId: string | null, decisions: Array<{ field: string; aiValue: string | null; confirmedValue: string | null; accepted: boolean }>): void {
  if (!analysisId || !decisions.length || !navigator.onLine) return;
  const clip = (v: string | null) => (v === null ? null : v.slice(0, 2000));
  void fetch('/api/photos/read', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysisId, decisions: decisions.slice(0, 20).map((d) => ({ ...d, aiValue: clip(d.aiValue), confirmedValue: clip(d.confirmedValue) })) }),
  }).catch(() => undefined);
}

'use client';
// Network side of offline sync: pushes pending estimates, pulls the pricing bundle and
// remote estimates. Safe to call often; only one run is in flight at a time.
import type { PricingBundle } from '@/lib/pricing';
import type { RemoteEstimate, SyncResponse } from '@/lib/sync/protocol';
import { db, getCachedBundle, META, setMeta, type LocalEstimate } from './db';
import { applySyncResult, mergeRemote } from './syncCore';

const uuid = () => crypto.randomUUID();
type Listener = () => void;
const listeners = new Set<Listener>();
let running: Promise<void> | null = null;

export function onSyncChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn());

export class AuthRequiredError extends Error {}

async function postSync(record: LocalEstimate): Promise<SyncResponse> {
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutationId: record.mutationId, baseRowVersion: record.draft.rowVersion, draft: record.draft }),
    });
    if (res.status === 401) throw new AuthRequiredError('Signed out');
    return (await res.json()) as SyncResponse;
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    return { status: 'error', error: navigator.onLine ? 'Could not reach the server.' : 'Offline. Will sync when back online.' };
  }
}

/** Pushes one estimate. Returns the stored record afterwards. */
export async function syncEstimate(id: string): Promise<LocalEstimate | undefined> {
  const record = await db().estimates.get(id);
  if (!record || !['pending', 'error'].includes(record.syncState)) return record;
  const sentMutationId = record.mutationId;
  const res = await postSync(record);
  let result: LocalEstimate | undefined;
  await db().transaction('rw', db().estimates, async () => {
    const current = await db().estimates.get(id);
    if (!current) return;
    result = applySyncResult(current, sentMutationId, res, new Date().toISOString());
    await db().estimates.put(result);
  });
  if (res.status === 'applied' && res.repriced) await refreshBundle();
  emit();
  return result;
}

async function pushAll(): Promise<void> {
  const pending = await db().estimates.where('syncState').anyOf('pending', 'error').toArray();
  for (const r of pending) {
    if (!navigator.onLine) break;
    await syncEstimate(r.id);
  }
}

/** Fetches the pricing bundle if it changed (ETag). Returns the cached or new bundle. */
export async function refreshBundle(): Promise<PricingBundle | null> {
  const cached = await getCachedBundle();
  try {
    const res = await fetch('/api/bundle', { headers: cached ? { 'If-None-Match': `"${cached.hash}"` } : {} });
    if (res.status === 401) throw new AuthRequiredError('Signed out');
    if (res.status === 304) return cached;
    if (!res.ok) return cached;
    const bundle = (await res.json()) as PricingBundle;
    await setMeta(META.bundle, bundle);
    emit();
    return bundle;
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    return cached;
  }
}

/** Pulls recent estimates from the server into the device. */
export async function pullEstimates(ownerId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/estimates');
  } catch {
    return; // offline or flaky signal; next cycle retries
  }
  if (res.status === 401) throw new AuthRequiredError('Signed out');
  if (!res.ok) return;
  const { estimates } = (await res.json()) as { estimates: RemoteEstimate[] };
  await db().transaction('rw', db().estimates, async () => {
    for (const remote of estimates) {
      const merged = mergeRemote(await db().estimates.get(remote.id), remote, ownerId, uuid());
      if (merged) await db().estimates.put(merged);
    }
  });
  emit();
}

/** Loads one estimate from the server (office opening someone's estimate from the list). */
export async function fetchEstimate(id: string, ownerId: string): Promise<LocalEstimate | null> {
  const local = await db().estimates.get(id);
  try {
    const res = await fetch(`/api/estimates/${id}`);
    if (!res.ok) return local ?? null;
    const remote = (await res.json()) as RemoteEstimate;
    const merged = mergeRemote(local, remote, ownerId, uuid());
    if (merged) await db().estimates.put(merged);
    emit();
    return merged ?? local ?? null;
  } catch {
    return local ?? null;
  }
}

/** Full cycle: push local edits, then refresh bundle and pull. */
export function syncAll(ownerId: string): Promise<void> {
  if (running) return running;
  running = (async () => {
    if (!navigator.onLine) return;
    await refreshBundle();
    await pushAll();
    await pullEstimates(ownerId);
  })().finally(() => {
    running = null;
    emit();
  });
  return running;
}

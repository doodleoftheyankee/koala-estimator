'use client';
// Asks the server for a satellite roof lookup (app/api/roof). Needs a connection; nothing here is
// queued or saved with the estimate.
//
// Lookups live here, one per area, so the sheet can close and open again: a lookup in flight keeps
// going (only Stop cancels it), and the last result for each area, with the estimator's overhang
// and faces, stays in memory for this visit. Reopening the sheet doesn't pay for another lookup.
import { useSyncExternalStore } from 'react';
import type { RoofChoices, RoofRequest, RoofResult } from '@/lib/roof/lookup';

export interface RoofLookup {
  lookupId: string;
  result: RoofResult;
  /** The address that was looked up (as the app sent it). */
  address: string;
}

export class LookupFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface AreaLookup {
  running: { startedAt: number; address: string; controller: AbortController } | null;
  last: RoofLookup | null;
  /** Overhang and faces chosen for `last`; null = the defaults. */
  choices: RoofChoices | null;
  error: LookupFailed | null;
}

const EMPTY: AreaLookup = { running: null, last: null, choices: null, error: null };
const areas = new Map<string, AreaLookup>();
const listeners = new Set<() => void>();

function patch(areaId: string, change: Partial<AreaLookup>) {
  areas.set(areaId, { ...(areas.get(areaId) ?? EMPTY), ...change });
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The lookup state of an area; re-renders when it changes. */
export function useAreaLookup(areaId: string): AreaLookup {
  return useSyncExternalStore(
    subscribe,
    () => areas.get(areaId) ?? EMPTY,
    () => EMPTY,
  );
}

export interface RoofService {
  configured: boolean;
  /** The Roof Takeoff site, for the "full takeoff" link; null when unknown. */
  url: string | null;
}

let service: Promise<RoofService> | null = null;
/** Whether the server has the lookup switched on. Only a "yes" is remembered, so adding the key works without reloading. */
export function roofLookupService(): Promise<RoofService> {
  service ??= fetch('/api/roof')
    .then(async (r) => {
      const b = (r.ok ? await r.json() : {}) as { configured?: boolean; url?: unknown };
      const s: RoofService = { configured: b.configured !== false, url: typeof b.url === 'string' ? b.url : null };
      if (!r.ok || !s.configured) service = null;
      return s;
    })
    .catch((): RoofService => {
      service = null; // offline: ask again next time
      return { configured: true, url: null };
    });
  return service;
}

/** Starts a lookup for an area (does nothing while one is running). */
export function startRoofLookup(req: RoofRequest): void {
  if (areas.get(req.areaId)?.running) return;
  const controller = new AbortController();
  patch(req.areaId, { running: { startedAt: Date.now(), address: req.address, controller }, error: null });
  requestLookup(req, controller.signal).then(
    (lookup) => patch(req.areaId, { running: null, last: lookup, choices: null }),
    (e: unknown) => {
      const error = e instanceof LookupFailed ? e : new LookupFailed('The lookup failed. Try again.', 'failed');
      if (error.code === 'not_configured') service = null;
      patch(req.areaId, { running: null, error: error.code === 'aborted' ? null : error });
    },
  );
}

/** Stops the lookup running for an area. */
export function stopRoofLookup(areaId: string): void {
  areas.get(areaId)?.running?.controller.abort();
}

/** Remembers the overhang and faces chosen for an area's last result. */
export function setLookupChoices(areaId: string, choices: RoofChoices): void {
  patch(areaId, { choices });
}

/** Asks the server to look the address up (usually 10–30 seconds). */
async function requestLookup(req: RoofRequest, signal: AbortSignal): Promise<RoofLookup> {
  let res: Response;
  try {
    res = await fetch('/api/roof', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new LookupFailed('Stopped.', 'aborted');
    throw new LookupFailed(navigator.onLine ? "Couldn't reach the server. Try again." : 'No signal. The satellite lookup needs a connection.', 'unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as { lookupId?: string; result?: RoofResult; error?: string; code?: string };
  if (!res.ok || !body.result) {
    const timedOut = res.status === 504 && !body.error;
    throw new LookupFailed(body.error ?? (timedOut ? 'The lookup took too long. Try again, or measure by hand.' : `The lookup failed (${res.status}). Try again.`), body.code ?? 'failed');
  }
  return { lookupId: body.lookupId ?? '', result: body.result, address: req.address };
}

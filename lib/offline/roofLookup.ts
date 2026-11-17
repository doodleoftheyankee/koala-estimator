'use client';
// Asks the server for a satellite roof lookup (app/api/roof). Needs a connection; nothing here is
// queued or saved with the estimate.
//
// Lookups live here, one per house (estimate + address; the Roof lookup page uses no estimate), so
// every area of the estimate shares the result, the overhang, the face choices and the roofing waste
// for this visit, and the sheet can close and open again: a lookup in flight keeps going (only Stop
// cancels it). Reopening the sheet, or opening it on another area of the same estimate, doesn't pay
// for another lookup; after a reload the server sends back its saved lookup of the same house
// instead of paying again. Which number an attic area uses (attic floor or roof deck) is kept per
// area. "Start an estimate here" on the Roof lookup page hands its lookup to the new estimate
// (seedHouse), across the page change, so opening the new area's lookup doesn't ask again.
import { useSyncExternalStore } from 'react';
import { addressKey, isRoofResult, type FaceGroup, type LatLng, type RoofChoices, type RoofPick, type RoofResult } from '@/lib/roof/lookup';
import type { RecentLookup } from '@/lib/roof/recent';

export interface RoofLookup {
  lookupId: string;
  result: RoofResult;
  /** The server sent back a saved lookup of the same house (no new charge). */
  reused: boolean;
  /** When the lookup was made (ISO time). */
  lookedUpAt: string;
  /** The spot the estimator tapped on the photo, or null for the address. */
  pin: LatLng | null;
}

export class LookupFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type FaceChoices = Pick<RoofChoices, 'excluded' | 'unmatchedOut'>;

export interface HouseLookup {
  running: { startedAt: number; pin: LatLng | null; controller: AbortController } | null;
  last: RoofLookup | null;
  error: LookupFailed | null;
  /** The request that failed, for Try again. */
  failed: { pin: LatLng | null; fresh: boolean } | null;
  /** The overhang chosen for this house; null = the default. */
  overhangIn: number | null;
  /** Face choices for `last`, per group (house areas share one, garages another); missing = the defaults. */
  faces: Partial<Record<FaceGroup, FaceChoices>>;
  /** The estimator said the outline is on the right house (for `last`). */
  confirmed: boolean;
  /** Roofing waste percent chosen for this house; null = the default. */
  wastePct: number | null;
  /**
   * The address Google matched when this house was last looked up by its address, kept when a roof
   * tapped on the photo (which has none) replaces it: "Start an estimate here" uses it.
   */
  matchedAddress: string | null;
}

export interface LookupRequest {
  /** The estimate and area it is for; null on the Roof lookup page. */
  estimateId: string | null;
  areaId: string | null;
  /** The estimate's address (the house this lookup belongs to). */
  address: string;
  /** Look up this spot instead of the address (the estimator tapped the right roof). */
  pin?: LatLng | null;
  /** Pay for a new lookup even if the server has a saved one ("Look up again"). */
  fresh?: boolean;
}

const EMPTY: HouseLookup = { running: null, last: null, error: null, failed: null, overhangIn: null, faces: {}, confirmed: false, wastePct: null, matchedAddress: null };
/** A new result's address, or the one kept from the house's earlier address lookup. */
const matchedFor = (key: string, lookup: RoofLookup) => lookup.result.address ?? houses.get(key)?.matchedAddress ?? null;
const houses = new Map<string, HouseLookup>();
const picks = new Map<string, RoofPick>();
const listeners = new Set<() => void>();

/** One house: the estimate (none on the Roof lookup page) and its address however it was typed. */
export const houseKey = (estimateId: string | null, address: string) => `${estimateId ?? 'page'}|${addressKey(address)}`;

function notify() {
  listeners.forEach((fn) => fn());
}

function patch(key: string, change: Partial<HouseLookup>) {
  houses.set(key, { ...(houses.get(key) ?? EMPTY), ...change });
  notify();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The lookup state of a house (estimate + address); re-renders when it changes. */
export function useHouseLookup(estimateId: string | null, address: string | null): HouseLookup {
  const key = address ? houseKey(estimateId, address) : null;
  return useSyncExternalStore(
    subscribe,
    () => (key ? (houses.get(key) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

/** The lookup state of a house right now (outside React). */
export function houseLookup(estimateId: string | null, address: string): HouseLookup {
  return houses.get(houseKey(estimateId, address)) ?? EMPTY;
}

/** Which number an attic area uses, once the estimator chose; null = not chosen. */
export function useAreaPick(areaId: string): RoofPick | null {
  return useSyncExternalStore(
    subscribe,
    () => picks.get(areaId) ?? null,
    () => null,
  );
}

export function setAreaPick(areaId: string, pick: RoofPick): void {
  picks.set(areaId, pick);
  notify();
}

export interface RoofService {
  configured: boolean;
}

let service: Promise<RoofService> | null = null;
/** Whether the server has the lookup switched on. Only a "yes" is remembered, so adding the key works without reloading. */
export function roofLookupService(): Promise<RoofService> {
  service ??= fetch('/api/roof')
    .then(async (r) => {
      const b = (r.ok ? await r.json() : {}) as { configured?: boolean };
      const s: RoofService = { configured: b.configured !== false };
      if (!r.ok || !s.configured) service = null;
      return s;
    })
    .catch((): RoofService => {
      service = null; // offline: ask again next time
      return { configured: true };
    });
  return service;
}

/** Starts a lookup for a house (does nothing while one is running for it). */
export function startRoofLookup(req: LookupRequest): void {
  const key = houseKey(req.estimateId, req.address);
  if (houses.get(key)?.running) return;
  const controller = new AbortController();
  const pin = req.pin ?? null;
  const fresh = req.fresh ?? false;
  patch(key, { running: { startedAt: Date.now(), pin, controller }, error: null, failed: null });
  requestLookup(req, controller.signal).then(
    // A new result: the overhang stays (same house), the face numbers may differ, so they start over.
    (lookup) => patch(key, { running: null, last: lookup, faces: {}, confirmed: false, matchedAddress: matchedFor(key, lookup) }),
    (e: unknown) => {
      const error = e instanceof LookupFailed ? e : new LookupFailed('The lookup failed. Try again.', 'failed');
      if (error.code === 'not_configured') service = null;
      patch(key, { running: null, error: error.code === 'aborted' ? null : error, failed: error.code === 'aborted' ? null : { pin, fresh } });
    },
  );
}

/** Stops the lookup running for a house. */
export function stopRoofLookup(estimateId: string | null, address: string): void {
  houses.get(houseKey(estimateId, address))?.running?.controller.abort();
}

/** Remembers the overhang chosen for a house (every area of the estimate uses it). */
export function setLookupOverhang(estimateId: string | null, address: string, overhangIn: number): void {
  patch(houseKey(estimateId, address), { overhangIn });
}

/** Remembers the roofing waste chosen for a house. */
export function setLookupWaste(estimateId: string | null, address: string, wastePct: number): void {
  patch(houseKey(estimateId, address), { wastePct });
}

/** Remembers the faces chosen for a house's last result, for the house areas or the garage. */
export function setLookupFaces(estimateId: string | null, address: string, group: FaceGroup, faces: FaceChoices): void {
  const key = houseKey(estimateId, address);
  patch(key, { faces: { ...(houses.get(key) ?? EMPTY).faces, [group]: faces } });
}

/** The estimator says the outline is on the right house. */
export function confirmHouse(estimateId: string | null, address: string): void {
  patch(houseKey(estimateId, address), { confirmed: true });
}

/** Shows a lookup that is already saved (a recent lookup) for a house, without asking Google again. */
export function showLookup(estimateId: string | null, address: string, lookup: RoofLookup): void {
  const key = houseKey(estimateId, address);
  if (houses.get(key)?.running) return;
  patch(key, { last: lookup, error: null, failed: null, faces: {}, confirmed: false, matchedAddress: matchedFor(key, lookup) });
}

// ---------------------------------------------------------------------------------------------
// Handing a lookup to a new estimate ("Start an estimate here")
// ---------------------------------------------------------------------------------------------

const SEEDS_KEY = 'koala.roofLookup.seeds';

export interface HouseSeed {
  estimateId: string;
  /** The new estimate's address, exactly as its areas will look it up (lookupAddress). */
  address: string;
  lookup: RoofLookup;
  overhangIn: number | null;
  faces: Partial<Record<FaceGroup, FaceChoices>>;
  confirmed: boolean;
  wastePct: number | null;
}

function adopt(seed: HouseSeed) {
  const key = houseKey(seed.estimateId, seed.address);
  if (houses.get(key)?.last) return;
  houses.set(key, { ...EMPTY, last: seed.lookup, overhangIn: seed.overhangIn, faces: seed.faces, confirmed: seed.confirmed, wastePct: seed.wastePct, matchedAddress: seed.lookup.result.address });
}

/**
 * Gives a new estimate's house the lookup the Roof lookup page showed (with its overhang, faces,
 * check and waste). Kept for this tab until the field app opens, so it survives the page change.
 */
export function seedHouse(seed: HouseSeed): void {
  adopt(seed);
  notify();
  try {
    const seeds = JSON.parse(sessionStorage.getItem(SEEDS_KEY) ?? '[]') as HouseSeed[];
    sessionStorage.setItem(SEEDS_KEY, JSON.stringify([...seeds.filter((x) => x.estimateId !== seed.estimateId), seed].slice(-5)));
  } catch {
    // No storage (private mode): the server still finds its saved lookup of the house.
  }
}

/** Takes the lookups handed over by the Roof lookup page in this tab (once). */
function adoptSeeds() {
  try {
    const raw = sessionStorage.getItem(SEEDS_KEY);
    if (!raw) return;
    sessionStorage.removeItem(SEEDS_KEY);
    for (const seed of JSON.parse(raw) as HouseSeed[]) {
      if (seed && typeof seed.estimateId === 'string' && typeof seed.address === 'string' && isRoofResult(seed.lookup?.result)) adopt(seed);
    }
  } catch {
    // Nothing usable: the server's saved lookup covers it.
  }
}
if (typeof window !== 'undefined') adoptSeeds();

// ---------------------------------------------------------------------------------------------
// Saved lookups (the Roof lookup page)
// ---------------------------------------------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new LookupFailed(navigator.onLine ? "Couldn't reach the server. Try again." : 'No signal. The roof lookup needs a connection.', 'unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw new LookupFailed(body.error ?? `That didn't work (${res.status}). Try again.`, body.code ?? 'failed');
  return body;
}

/** The caller's recent finished lookups (the owner's: everyone's). */
export async function fetchRecentLookups(): Promise<RecentLookup[]> {
  const body = await getJson<{ lookups?: RecentLookup[] }>('/api/roof?recent=1');
  return Array.isArray(body.lookups) ? body.lookups : [];
}

/** One saved lookup, as it was looked up (no new Google call). */
export async function fetchSavedLookup(lookupId: string): Promise<RoofLookup> {
  const body = await getJson<{ lookupId?: string; result?: RoofResult; lookedUpAt?: string; pin?: LatLng | null }>(`/api/roof?id=${encodeURIComponent(lookupId)}`);
  if (!isRoofResult(body.result)) throw new LookupFailed('This lookup was saved by an older version of the app. Look the address up again.', 'old');
  return { lookupId: body.lookupId ?? lookupId, result: body.result, reused: true, lookedUpAt: body.lookedUpAt ?? new Date().toISOString(), pin: body.pin ?? null };
}

/** Asks the server to look the address (or the tapped spot) up: usually 10–30 seconds, or at once for a saved lookup. */
async function requestLookup(req: LookupRequest, signal: AbortSignal): Promise<RoofLookup> {
  const pin = req.pin ?? null;
  const body = {
    ...(req.estimateId ? { estimateId: req.estimateId } : {}),
    ...(req.areaId ? { areaId: req.areaId } : {}),
    ...(pin ? { lat: pin.lat, lng: pin.lng } : { address: req.address }),
    ...(req.fresh ? { fresh: true } : {}),
  };
  let res: Response;
  try {
    res = await fetch('/api/roof', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new LookupFailed('Stopped.', 'aborted');
    throw new LookupFailed(navigator.onLine ? "Couldn't reach the server. Try again." : 'No signal. The satellite lookup needs a connection.', 'unreachable');
  }
  const answer = (await res.json().catch(() => ({}))) as { lookupId?: string; result?: RoofResult; reused?: boolean; lookedUpAt?: string; error?: string; code?: string };
  if (!res.ok || !answer.result) {
    const timedOut = res.status === 504 && !answer.error;
    throw new LookupFailed(answer.error ?? (timedOut ? 'The lookup took too long. Try again, or measure by hand.' : `The lookup failed (${res.status}). Try again.`), answer.code ?? 'failed');
  }
  return { lookupId: answer.lookupId ?? '', result: answer.result, reused: answer.reused === true, lookedUpAt: answer.lookedUpAt ?? new Date().toISOString(), pin };
}

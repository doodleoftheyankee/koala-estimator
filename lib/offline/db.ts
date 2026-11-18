'use client';
// On-device storage (IndexedDB via Dexie). Estimates live here first; the server is a sync target.
import Dexie, { type Table } from 'dexie';
import type { PricingBundle, Role } from '@/lib/pricing';
import type { EstimateDraft } from '@/lib/sync/draft';

export type SyncState =
  | 'local' // incomplete; not ready to sync yet
  | 'pending' // has unsynced edits
  | 'synced'
  | 'conflict' // changed on another device; user must choose
  | 'locked' // signed on the server; read-only
  | 'invalid' // server rejected the data; user must fix
  | 'error'; // transient failure; will retry

export interface LocalEstimate {
  id: string;
  /** User who created/opened it on this device; the list only shows the signed-in user's. */
  ownerId: string;
  draft: EstimateDraft;
  syncState: SyncState;
  /** Changes on every local edit. Sent as the idempotency key; tells us if an edit happened mid-sync. */
  mutationId: string;
  lastError: string | null;
  serverDoc: EstimateDraft | null;
  serverRowVersion: number | null;
  updatedAt: string;
  syncedAt: string | null;
  /** Price of the recommended option at last save, for the list view. */
  summaryPrice?: number | null;
}

/** A new estimate as this phone first stores it: not synced, nothing from the server yet. */
export function newLocalEstimate(draft: EstimateDraft, ownerId: string, now = new Date().toISOString()): LocalEstimate {
  return {
    id: draft.id,
    ownerId,
    draft,
    syncState: 'local',
    mutationId: crypto.randomUUID(),
    lastError: null,
    serverDoc: null,
    serverRowVersion: null,
    updatedAt: now,
    syncedAt: null,
  };
}

/** A photo of an estimate area, kept on the phone until it's uploaded (lib/offline/photos.ts). */
export interface LocalPhoto {
  id: string;
  estimateId: string;
  areaId: string;
  ownerId: string;
  takenAt: string;
  /** Downscaled photo (≤2000px JPEG) and a small preview. */
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
  /** pending → uploaded; 'deleting' waits for the server delete before the row goes. */
  state: 'pending' | 'uploaded' | 'deleting';
  lastError: string | null;
}

export interface CachedProfile {
  userId: string;
  fullName: string;
  role: Role;
  /** The store the person is working in on this phone, and what new estimates need from it. */
  locationId: string;
  locationName: string;
  /** The store's town (its short name) and state: a new estimate's address starts with them. */
  town?: string;
  state: string;
  timeZone: string;
  utilities: string[];
  /** Works in more than one store (the list offers a way to switch). */
  multiStore?: boolean;
}

interface MetaRow {
  key: string;
  value: unknown;
}

class KoalaDB extends Dexie {
  estimates!: Table<LocalEstimate, string>;
  meta!: Table<MetaRow, string>;
  photos!: Table<LocalPhoto, string>;

  constructor() {
    super('koala-estimator');
    this.version(1).stores({
      estimates: 'id, ownerId, syncState, updatedAt',
      meta: 'key',
    });
    this.version(2).stores({
      photos: 'id, estimateId, areaId, ownerId, state',
    });
  }
}

let instance: KoalaDB | null = null;
export function db(): KoalaDB {
  instance ??= new KoalaDB();
  return instance;
}

export async function getMeta<T>(key: string): Promise<T | null> {
  return ((await db().meta.get(key))?.value as T | undefined) ?? null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db().meta.put({ key, value });
}

export const META = {
  bundle: 'bundle',
  profile: 'profile',
} as const;

/**
 * The cached pricing bundle. With a store, only that store's bundle: an estimate is never priced
 * on this phone with another store's prices (a bundle cached before stores existed is the pilot
 * store's and still counts).
 */
export async function getCachedBundle(locationId?: string | null): Promise<PricingBundle | null> {
  const bundle = await getMeta<PricingBundle>(META.bundle);
  if (!bundle || !locationId || !bundle.location) return bundle;
  return bundle.location.id === locationId ? bundle : null;
}

/**
 * When a different user signs in on this device, drop the previous user's *synced* copies
 * (they are safe on the server) and the cached bundle; when the same user switches store, drop
 * the cached bundle. Unsynced work is kept, hidden, until
 * its owner signs back in, so nothing typed in an attic is ever lost.
 */
export async function switchUser(profile: CachedProfile): Promise<void> {
  const prev = await getMeta<CachedProfile>(META.profile);
  if (prev && prev.userId === profile.userId && prev.locationId !== profile.locationId) {
    // Same person, another store: that store's prices must be downloaded before pricing.
    await db().meta.delete(META.bundle);
  }
  if (prev && prev.userId !== profile.userId) {
    await db().estimates.where('ownerId').equals(prev.userId).and((e) => e.syncState === 'synced' || e.syncState === 'locked').delete();
    // Uploaded photos are safe on the server; ones still waiting to upload stay, like unsynced estimates.
    await db().photos.where('ownerId').equals(prev.userId).and((p) => p.state === 'uploaded').delete();
    await db().meta.delete(META.bundle);
  }
  await setMeta(META.profile, profile);
}

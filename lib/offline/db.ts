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

export async function getCachedBundle(): Promise<PricingBundle | null> {
  return getMeta<PricingBundle>(META.bundle);
}

/**
 * When a different user signs in on this device, drop the previous user's *synced* copies
 * (they are safe on the server) and the cached bundle. Unsynced work is kept, hidden, until
 * its owner signs back in, so nothing typed in an attic is ever lost.
 */
export async function switchUser(profile: CachedProfile): Promise<void> {
  const prev = await getMeta<CachedProfile>(META.profile);
  if (prev && prev.userId !== profile.userId) {
    await db().estimates.where('ownerId').equals(prev.userId).and((e) => e.syncState === 'synced' || e.syncState === 'locked').delete();
    // Uploaded photos are safe on the server; ones still waiting to upload stay, like unsynced estimates.
    await db().photos.where('ownerId').equals(prev.userId).and((p) => p.state === 'uploaded').delete();
    await db().meta.delete(META.bundle);
  }
  await setMeta(META.profile, profile);
}

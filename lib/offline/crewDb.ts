'use client';
// On-device storage for the crew app (IndexedDB via Dexie), separate from the estimator's
// database. Jobs are a read-only cache of GET /api/crew/jobs; actuals are drafts the crew types
// on site, synced through an outbox (lib/offline/crewSync.ts).
import Dexie, { type Table } from 'dexie';
import type { ProductCode, ProductUnit } from '@/lib/pricing';
import type { CrewJob } from '@/lib/jobs/crew';
import type { CachedProfile } from './db';

export type ActualsSyncState =
  | 'pending' // has unsynced edits
  | 'synced'
  | 'locked' // verified by the office; read-only
  | 'invalid' // server rejected the data; the crew must fix it
  | 'error'; // transient failure; will retry

/** One actuals row on the phone. Area + product, or neither for the job-level row. */
export interface DraftActualRow {
  /** Stable client uuid (crypto.randomUUID once), or the server's id once it has the row. */
  id: string;
  areaId: string | null;
  product: ProductCode | null;
  materialQty: number | null;
  /** The scope's unit for this product's material; null when there is no material line. */
  materialUnit: ProductUnit | null;
  hours: number | null; // person-hours
  crewSize: number | null; // job row
  driveMinutes: number | null; // job row: average one-way
  days: number | null; // job row: days on site
  notes: string | null;
  /** The server has this row (baseVersion is set). */
  onServer: boolean;
  /**
   * The server's values and row_version as this phone last saw them (null: no server row yet).
   * A row is sent only when its values differ from `base`, with `baseVersion`; when the server
   * row changed meanwhile, the two edits are merged field by field (see crewSyncCore).
   */
  base: ActualValues | null;
  baseVersion: number | null;
  /** Shown on the row after a merge kept someone else's value over the crew's. */
  changedElsewhere: string | null;
}

/** The values the crew enters on one row. */
export interface ActualValues {
  materialQty: number | null;
  hours: number | null;
  crewSize: number | null;
  driveMinutes: number | null;
  days: number | null;
  notes: string | null;
}

export interface LocalActuals {
  jobId: string;
  /** User who loaded the job on this device; lists only show the signed-in user's. */
  ownerId: string;
  rows: DraftActualRow[];
  syncState: ActualsSyncState;
  /** Changes on every local edit; sent as the idempotency key. */
  mutationId: string;
  lastError: string | null;
  updatedAt: string;
  syncedAt: string | null;
}

export interface LocalJob {
  id: string; // job id
  ownerId: string;
  job: CrewJob;
  fetchedAt: string;
}

interface MetaRow {
  key: string;
  value: unknown;
}

class CrewDB extends Dexie {
  jobs!: Table<LocalJob, string>;
  actuals!: Table<LocalActuals, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('koala-crew');
    this.version(1).stores({
      jobs: 'id, ownerId',
      actuals: 'jobId, ownerId, syncState',
      meta: 'key',
    });
  }
}

let instance: CrewDB | null = null;
export function crewDb(): CrewDB {
  instance ??= new CrewDB();
  return instance;
}

const PROFILE_KEY = 'profile';

/**
 * When a different user signs in on this device, drop the previous user's synced copies (they
 * are safe on the server). Unsynced actuals are kept, hidden, until their owner signs back in.
 */
export async function switchCrewUser(profile: CachedProfile): Promise<void> {
  const prev = (await crewDb().meta.get(PROFILE_KEY))?.value as CachedProfile | undefined;
  if (prev && prev.userId !== profile.userId) {
    await crewDb().transaction('rw', crewDb().jobs, crewDb().actuals, async () => {
      const keep = new Set(
        (await crewDb().actuals.where('ownerId').equals(prev.userId).toArray())
          .filter((a) => a.syncState !== 'synced' && a.syncState !== 'locked')
          .map((a) => a.jobId),
      );
      await crewDb().actuals.where('ownerId').equals(prev.userId).and((a) => !keep.has(a.jobId)).delete();
      await crewDb().jobs.where('ownerId').equals(prev.userId).and((j) => !keep.has(j.id)).delete();
    });
  }
  await crewDb().meta.put({ key: PROFILE_KEY, value: profile });
}

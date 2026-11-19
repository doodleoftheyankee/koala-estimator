'use client';
// The blower door tool on the phone (IndexedDB via Dexie), shared by every role that uses it: the
// estimator's field app and the crew app each keep their own database, so the tool keeps its own.
//
//   meta      the franchise's rebate programs (GET /api/blower-door/settings), cached like the
//             pricing bundle so the tool works with no signal; and who last used the tool here
//   forms     what was typed, per person and per job, estimate or the plain calculator, so the
//             numbers are still there on the next visit
//   contexts  the last copy of a job's or estimate's saved readings and who it is for
//   tests     the outbox: readings saved on this phone until the server's list has them
//
// syncBlowerDoor() sends the outbox (idempotent on each reading's mutation id and its own id, so
// nothing is stored twice). The field app's and the crew app's own sync cycles call it with
// refreshBlowerDoorSettings(), and the tool calls it itself. It never throws.
import Dexie, { type Table } from 'dexie';
import {
  contextResponseSchema,
  EMPTY_SETTINGS,
  type BlowerDoorForm,
  type BlowerDoorSettings,
  type ContextResponse,
  type SavedTest,
  type SettingsResponse,
  type TestKind,
  type TestSyncResponse,
} from '@/lib/blowerdoor';
import type { CachedProfile } from './db';

export type { CachedProfile };
import { applyTestResult, contextKey, isUnsent, settledLocalIds, testSyncAnswer, type BlowerDoorContext, type LocalTest } from './blowerDoorCore';

export interface CachedSettings extends SettingsResponse {
  fetchedAt: string;
}

export interface LocalForm {
  /** ownerId|contextKey */
  key: string;
  ownerId: string;
  contextKey: string;
  form: BlowerDoorForm;
  /** A saved reading is shown as recorded; "Retake" types a new one over it. */
  retake: Record<TestKind, boolean>;
  /** The house (BAS inputs) of a saved reading has filled the empty fields once. */
  houseFilled?: boolean;
  updatedAt: string;
}

export interface LocalContext {
  /** ownerId|contextKey */
  key: string;
  ownerId: string;
  contextKey: string;
  jobId: string | null;
  estimateId: string | null;
  label: string | null;
  tests: SavedTest[];
  fetchedAt: string;
}

interface MetaRow {
  key: string;
  value: unknown;
}

class BlowerDoorDB extends Dexie {
  meta!: Table<MetaRow, string>;
  forms!: Table<LocalForm, string>;
  contexts!: Table<LocalContext, string>;
  tests!: Table<LocalTest, string>;

  constructor() {
    super('koala-blower-door');
    this.version(1).stores({
      meta: 'key',
      forms: 'key, ownerId',
      contexts: 'key, ownerId',
      tests: 'id, ownerId, contextKey, syncState',
    });
  }
}

let instance: BlowerDoorDB | null = null;
export function blowerDoorDb(): BlowerDoorDB {
  instance ??= new BlowerDoorDB();
  return instance;
}

const SETTINGS_KEY = 'settings';
const PROFILE_KEY = 'profile';
export const formKey = (ownerId: string, c: BlowerDoorContext | null) => `${ownerId}|${contextKey(c)}`;

type Listener = () => void;
const listeners = new Set<Listener>();
/** Re-render when a sync starts or ends. */
export function subscribeBlowerDoorSync(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn());
let running: Promise<SyncOutcome> | null = null;
export const isBlowerDoorSyncing = () => running !== null;

// Can Koala be reached? (L36) A 503 from Koala's own server means its database or sign-in service
// is not answering: not a sign-out, and not this phone's signal. The tool says "Can't reach Koala
// right now" while it lasts; readings stay on the phone and are sent when Koala answers again.
let reachable = true;
function noteResponse(res: Response) {
  const r = res.status !== 503;
  if (r === reachable) return;
  reachable = r;
  emit();
}
/** False after Koala's server answered 503 to the tool, until it answers again. */
export const isBlowerDoorReachable = () => reachable;

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export async function getCachedSettings(): Promise<CachedSettings | null> {
  try {
    return ((await blowerDoorDb().meta.get(SETTINGS_KEY))?.value as CachedSettings | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The programs to use: the cached copy, or none (the tool still converts and checks ventilation). */
export const settingsOrEmpty = (c: CachedSettings | null): BlowerDoorSettings => c?.settings ?? EMPTY_SETTINGS;

/** Fetches the programs if they changed (ETag). Returns the cached or new copy; never throws. */
export async function refreshBlowerDoorSettings(): Promise<CachedSettings | null> {
  const cached = await getCachedSettings();
  try {
    const res = await fetch('/api/blower-door/settings', { headers: cached ? { 'If-None-Match': `"${cached.hash}"` } : {}, cache: 'no-store' });
    noteResponse(res);
    if (res.status === 304 && cached) {
      const fresh = { ...cached, fetchedAt: new Date().toISOString() };
      await blowerDoorDb().meta.put({ key: SETTINGS_KEY, value: fresh });
      return fresh;
    }
    if (!res.ok) return cached;
    const body = (await res.json()) as SettingsResponse;
    const next: CachedSettings = { ...body, fetchedAt: new Date().toISOString() };
    await blowerDoorDb().meta.put({ key: SETTINGS_KEY, value: next });
    emit();
    return next;
  } catch {
    return cached;
  }
}

// ---------------------------------------------------------------------------------------------
// Who uses the tool on this phone
// ---------------------------------------------------------------------------------------------

/**
 * When someone else signs in on this phone, drop the previous person's copies of the server's
 * readings and the readings the server already has. Readings still to send stay, hidden, until
 * their owner signs back in: they never go out under another person's session.
 */
export async function switchBlowerDoorUser(profile: CachedProfile): Promise<void> {
  const db = blowerDoorDb();
  const prev = (await db.meta.get(PROFILE_KEY))?.value as CachedProfile | undefined;
  if (prev && prev.userId !== profile.userId) {
    await db.transaction('rw', db.contexts, db.tests, async () => {
      await db.contexts.where('ownerId').equals(prev.userId).delete();
      await db.tests.where('ownerId').equals(prev.userId).and((t) => t.syncState === 'synced').delete();
    });
  }
  await db.meta.put({ key: PROFILE_KEY, value: profile });
}

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

export async function saveForm(row: LocalForm): Promise<void> {
  try {
    await blowerDoorDb().forms.put(row);
  } catch (e) {
    console.error('[blower door] could not keep the form on this phone', e);
  }
}

// ---------------------------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------------------------

/** Puts a reading in the outbox and tries to send it right away. */
export async function queueTest(t: LocalTest): Promise<void> {
  await blowerDoorDb().tests.put(t);
  emit();
  if (navigator.onLine) void syncBlowerDoor(t.ownerId);
}

async function postTest(t: LocalTest): Promise<TestSyncResponse | 'signed-out'> {
  let res: Response;
  try {
    res = await fetch('/api/blower-door/tests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutationId: t.mutationId, test: t.test }),
    });
  } catch {
    return { status: 'error', error: navigator.onLine ? 'Could not reach the server. Will retry.' : 'No signal. Saved on this phone; it syncs when you are back online.' };
  }
  noteResponse(res);
  return testSyncAnswer(res.status, await res.json().catch(() => null));
}

export type SyncOutcome = 'done' | 'offline' | 'signed-out';

/** Sends this person's unsent readings. One run at a time; never throws. */
export function syncBlowerDoor(ownerId: string): Promise<SyncOutcome> {
  if (running) return running;
  running = (async (): Promise<SyncOutcome> => {
    if (!navigator.onLine) return 'offline';
    const db = blowerDoorDb();
    const outbox = (await db.tests.where('ownerId').equals(ownerId).toArray()).filter(isUnsent);
    for (const t of outbox) {
      if (!navigator.onLine) return 'offline';
      const res = await postTest(t);
      if (res === 'signed-out') return 'signed-out';
      await db.transaction('rw', db.tests, async () => {
        const current = await db.tests.get(t.id);
        if (current) await db.tests.put(applyTestResult(current, res, new Date().toISOString()));
      });
    }
    return 'done';
  })()
    .catch((e) => {
      console.error('[blower door] sync failed', e);
      return 'done' as const;
    })
    .finally(() => {
      running = null;
      emit();
    });
  emit();
  return running;
}

/**
 * Loads who a job or estimate is for and its saved readings, and keeps the copy for offline use.
 * Returns 'not-found' when the server says this person cannot see it, null without signal.
 */
export async function fetchContext(c: BlowerDoorContext, ownerId: string): Promise<LocalContext | 'not-found' | 'signed-out' | null> {
  let res: Response;
  try {
    res = await fetch(`/api/blower-door/tests?${c.kind}=${encodeURIComponent(c.id)}`, { cache: 'no-store' });
  } catch {
    return null;
  }
  noteResponse(res);
  if (res.status === 401) return 'signed-out';
  if (res.status === 404 || res.status === 403) return 'not-found';
  if (!res.ok) return null;
  const parsed = contextResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return null;
  const body: ContextResponse = parsed.data;
  const db = blowerDoorDb();
  const row: LocalContext = {
    key: formKey(ownerId, c),
    ownerId,
    contextKey: contextKey(c),
    jobId: body.jobId,
    estimateId: body.estimateId,
    label: body.label,
    tests: body.tests,
    fetchedAt: new Date().toISOString(),
  };
  await db.transaction('rw', db.contexts, db.tests, async () => {
    await db.contexts.put(row);
    const local = await db.tests.where('contextKey').equals(contextKey(c)).toArray();
    const settled = settledLocalIds(body.tests, local);
    if (settled.length) await db.tests.bulkDelete(settled);
  });
  return row;
}

/** Unsent readings of one person (for "2 readings will sync"). */
export async function unsentCount(ownerId: string): Promise<number> {
  try {
    return (await blowerDoorDb().tests.where('ownerId').equals(ownerId).toArray()).filter(isUnsent).length;
  } catch {
    return 0;
  }
}

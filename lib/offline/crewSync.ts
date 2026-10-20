'use client';
// Network side of the crew app: pulls assigned jobs, pushes actuals drafts through an outbox,
// and changes job status (online only). Safe to call often; one full sync runs at a time.
import { z } from 'zod';
import { crewJobsResponseSchema, type ActualsSyncResponse } from '@/lib/jobs/crew';
import type { JobStatus } from '@/lib/jobs/status';
import { crewDb, type LocalActuals } from './crewDb';
import { applyActualsResult, buildActualsBody, mergeServerJobs, withStatus } from './crewSyncCore';

const uuid = () => crypto.randomUUID();
let running: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** For useSyncExternalStore: re-render when a full sync starts or ends. */
export function subscribeCrewSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const isCrewSyncing = () => running !== null;

export class CrewAuthRequiredError extends Error {}

const responseSchema = z.union([
  z.object({ status: z.literal('applied'), rows: z.number() }),
  z.object({ status: z.enum(['locked', 'conflict', 'invalid', 'error']), error: z.string() }),
]);

const offlineMessage = () => (navigator.onLine ? 'Could not reach the server.' : 'Offline. Will sync when back online.');

async function postActuals(body: unknown): Promise<ActualsSyncResponse> {
  let res: Response;
  try {
    res = await fetch('/api/crew/actuals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { status: 'error', error: offlineMessage() };
  }
  if (res.status === 401) throw new CrewAuthRequiredError('Signed out');
  const parsed = responseSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : { status: 'error', error: `The server answered ${res.status}. Will retry.` };
}

/** Pushes one job's actuals if they have unsynced edits. Returns the stored draft and the server's answer. */
export async function syncActuals(jobId: string): Promise<{ record: LocalActuals | undefined; status: ActualsSyncResponse['status'] | null }> {
  const record = await crewDb().actuals.get(jobId);
  if (!record || (record.syncState !== 'pending' && record.syncState !== 'error')) return { record, status: null };
  const built = buildActualsBody(record);
  if (!built.ok) {
    const invalid: LocalActuals = { ...record, syncState: 'invalid', lastError: built.error };
    await crewDb().actuals.put(invalid);
    return { record: invalid, status: 'invalid' };
  }
  const res = await postActuals(built.body);
  let result: LocalActuals | undefined;
  await crewDb().transaction('rw', crewDb().actuals, async () => {
    const current = await crewDb().actuals.get(jobId);
    if (!current) return;
    result = applyActualsResult(current, { mutationId: record.mutationId, rowIds: built.body.rows.map((r) => r.id) }, res, new Date().toISOString());
    await crewDb().actuals.put(result);
  });
  return { record: result, status: res.status };
}

/** Pushes every draft with unsynced edits. True when one hit a conflict (row ids to adopt from the server). */
async function pushAll(): Promise<boolean> {
  const pending = await crewDb().actuals.where('syncState').anyOf('pending', 'error').toArray();
  let conflict = false;
  for (const d of pending) {
    if (!navigator.onLine) break;
    const { status } = await syncActuals(d.jobId);
    if (status === 'conflict') conflict = true;
  }
  return conflict;
}

/** Refreshes the cached jobs (and their server actuals) from the server. */
export async function pullJobs(ownerId: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch('/api/crew/jobs', { cache: 'no-store' });
  } catch {
    return false; // offline or flaky signal; the next cycle retries
  }
  if (res.status === 401) throw new CrewAuthRequiredError('Signed out');
  if (!res.ok) return false;
  const parsed = crewJobsResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return false;
  const db = crewDb();
  await db.transaction('rw', db.jobs, db.actuals, async () => {
    const plan = mergeServerJobs({
      jobs: await db.jobs.toArray(),
      drafts: await db.actuals.toArray(),
      server: parsed.data.jobs,
      ownerId,
      now: new Date().toISOString(),
      newId: uuid,
    });
    if (plan.putJobs.length) await db.jobs.bulkPut(plan.putJobs);
    if (plan.deleteJobIds.length) await db.jobs.bulkDelete(plan.deleteJobIds);
    if (plan.putDrafts.length) await db.actuals.bulkPut(plan.putDrafts);
    if (plan.deleteDraftIds.length) await db.actuals.bulkDelete(plan.deleteDraftIds);
  });
  return true;
}

/** Full cycle: push edits, pull jobs, and push again if a conflict needed the server's row ids. */
export function crewSyncAll(ownerId: string): Promise<void> {
  if (running) return running;
  running = (async () => {
    if (!navigator.onLine) return;
    const conflict = await pushAll();
    await pullJobs(ownerId);
    if (conflict) await pushAll();
  })().finally(() => {
    running = null;
    emit();
  });
  emit();
  return running;
}

const statusResponse = z.object({
  status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/** Starts or completes a job. Online only: nothing is queued. */
export async function setJobStatus(jobId: string, status: JobStatus): Promise<{ ok: true } | { ok: false; error: string; blockers?: string[] }> {
  let res: Response;
  try {
    res = await fetch(`/api/crew/jobs/${encodeURIComponent(jobId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  } catch {
    return { ok: false, error: 'No signal. Try again when you are back online; your actuals are saved on this phone.' };
  }
  if (res.status === 401) throw new CrewAuthRequiredError('Signed out');
  const json: unknown = await res.json().catch(() => null);
  const ok = statusResponse.safeParse(json);
  if (!res.ok || !ok.success) {
    const err = z.object({ error: z.string(), blockers: z.array(z.string()).optional() }).safeParse(json);
    return { ok: false, error: err.success ? err.data.error : `The server answered ${res.status}.`, blockers: err.success ? err.data.blockers : undefined };
  }
  await crewDb().transaction('rw', crewDb().jobs, async () => {
    const cached = await crewDb().jobs.get(jobId);
    if (cached) await crewDb().jobs.put({ ...cached, job: withStatus(cached.job, ok.data) });
  });
  return { ok: true };
}

// Pure decisions for the crew app's offline actuals, separated from IndexedDB/fetch so they can
// be unit tested: which rows a job needs, when they are complete, what to send, how to apply
// the server's answer, and how to merge a fresh job list without losing unsynced work.
import type { ProductCode, ProductUnit } from '@/lib/pricing';
import {
  actualsBodySchema,
  LOCKED_MESSAGE,
  naturalKey,
  PRODUCT_LABELS,
  UNIT_LABELS,
  type ActualsBody,
  type ActualsRow,
  type ActualsSyncResponse,
  type CrewJob,
  type ServerActual,
} from '@/lib/jobs/crew';
import type { JobStatus } from '@/lib/jobs/status';
import type { DraftActualRow, LocalActuals, LocalJob } from './crewDb';

// ---------------------------------------------------------------------------
// Expected rows and completeness
// ---------------------------------------------------------------------------

/** One row the crew should fill in: an area x product from the signed scope, or the job row. */
export interface ExpectedRow {
  key: string; // naturalKey(areaId, product)
  areaId: string | null;
  areaName: string | null;
  product: ProductCode | null;
  label: string;
  /** Unit of the scope's material line; null when the product has no material (removal, some air sealing). */
  unit: ProductUnit | null;
  estQty: number | null;
  estHours: number | null;
  needsQty: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Area x product rows in scope order, then the job-level row (drive, days, crew size). */
export function expectedRows(job: Pick<CrewJob, 'areas'>): ExpectedRow[] {
  const out: ExpectedRow[] = [];
  for (const area of job.areas) {
    const byProduct = new Map<ProductCode, ExpectedRow>();
    for (const line of area.scope) {
      let row = byProduct.get(line.product);
      if (!row) {
        row = {
          key: naturalKey(area.areaId, line.product),
          areaId: area.areaId,
          areaName: area.name,
          product: line.product,
          label: PRODUCT_LABELS[line.product],
          unit: null,
          estQty: null,
          estHours: null,
          needsQty: false,
        };
        byProduct.set(line.product, row);
        out.push(row);
      }
      if (line.kind === 'material') {
        row.needsQty = true;
        row.unit ??= line.unit;
        if (line.qty !== null) row.estQty = round2((row.estQty ?? 0) + line.qty);
      } else if (line.hours !== null) {
        // Labor lines carry install hours; removal lines carry removal hours.
        row.estHours = round2((row.estHours ?? 0) + line.hours);
      }
    }
  }
  out.push({ key: 'job', areaId: null, areaName: null, product: null, label: 'Whole job', unit: null, estQty: null, estHours: null, needsQty: false });
  return out;
}

/** The value fields shared by draft rows and server rows. */
export type RowValues = Pick<DraftActualRow, 'materialQty' | 'hours' | 'crewSize' | 'driveMinutes' | 'days' | 'notes'>;
type KeyedValues = RowValues & { areaId: string | null; product: ProductCode | null };

/** What is still missing for one expected row (empty when complete). */
export function missingFor(expected: ExpectedRow, row: Partial<RowValues> | undefined): string[] {
  const missing: string[] = [];
  if (expected.areaId === null) {
    if (row?.driveMinutes == null) missing.push('drive minutes');
    if (row?.days == null) missing.push('days on site');
    if (row?.crewSize == null) missing.push('crew size');
    return missing;
  }
  if (expected.needsQty && row?.materialQty == null) missing.push(expected.unit ? `${UNIT_LABELS[expected.unit]} used` : 'material used');
  if (row?.hours == null) missing.push('person-hours');
  return missing;
}

export function rowComplete(expected: ExpectedRow, row: Partial<RowValues> | undefined): boolean {
  return missingFor(expected, row).length === 0;
}

const joinList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Why the job cannot be completed yet: every scope row needs hours (material rows also the
 * quantity used) and the job row needs drive minutes, days on site and crew size.
 */
export function completionBlockers(job: Pick<CrewJob, 'areas'>, rows: readonly KeyedValues[]): string[] {
  const byKey = new Map(rows.map((r) => [naturalKey(r.areaId, r.product), r]));
  const out: string[] = [];
  for (const e of expectedRows(job)) {
    const missing = missingFor(e, byKey.get(e.key));
    if (missing.length) out.push(`${e.areaName ? `${e.areaName} · ${e.label}` : e.label}: enter ${joinList(missing)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const UNSYNCED = new Set(['pending', 'error', 'invalid']);
export const isUnsynced = (d: Pick<LocalActuals, 'syncState'>) => UNSYNCED.has(d.syncState);

export function emptyRow(id: string, areaId: string | null, product: ProductCode | null, unit: ProductUnit | null): DraftActualRow {
  return { id, areaId, product, materialQty: null, materialUnit: unit, hours: null, crewSize: null, driveMinutes: null, days: null, notes: null, onServer: false };
}

function fromServer(s: ServerActual, unit: ProductUnit | null): DraftActualRow {
  return {
    id: s.id,
    areaId: s.areaId,
    product: s.product,
    materialQty: s.materialQty,
    materialUnit: unit,
    hours: s.hours,
    crewSize: s.crewSize,
    driveMinutes: s.driveMinutes,
    days: s.days,
    notes: s.notes,
    onServer: true,
  };
}

export function rowHasValue(r: RowValues): boolean {
  return r.materialQty !== null || r.hours !== null || r.crewSize !== null || r.driveMinutes !== null || r.days !== null || !!r.notes?.trim();
}

/**
 * Lines the local rows up with the job: one row per expected row (scope order), then rows the
 * server or the phone has beyond the scope. Server rows always lend their id (the database is
 * unique on job x area x product, so a second id for the same row would be refused); their
 * values replace the phone's only when `adoptServerValues` (nothing unsynced on the phone).
 */
export function reconcileRows(local: readonly DraftActualRow[], job: CrewJob, newId: () => string, adoptServerValues: boolean): DraftActualRow[] {
  const expected = new Map(expectedRows(job).map((e) => [e.key, e]));
  const localByKey = new Map(local.map((r) => [naturalKey(r.areaId, r.product), r]));
  const serverByKey = new Map(job.actuals.map((a) => [naturalKey(a.areaId, a.product), a]));
  const keys = [...expected.keys(), ...serverByKey.keys(), ...localByKey.keys()];

  const out: DraftActualRow[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const exp = expected.get(key);
    const mine = localByKey.get(key);
    const theirs = serverByKey.get(key);
    const unit = exp?.unit ?? mine?.materialUnit ?? theirs?.materialUnit ?? null;
    if (theirs && (!mine || adoptServerValues)) out.push(fromServer(theirs, unit));
    else if (theirs && mine) out.push({ ...mine, id: theirs.id, materialUnit: unit, onServer: true });
    else if (mine) out.push({ ...mine, materialUnit: unit });
    else if (exp) out.push(emptyRow(newId(), exp.areaId, exp.product, unit));
  }
  return out;
}

export function initialActuals(job: CrewJob, ownerId: string, newId: () => string, now: string): LocalActuals {
  return {
    jobId: job.jobId,
    ownerId,
    rows: reconcileRows([], job, newId, true),
    syncState: job.verified ? 'locked' : 'synced',
    mutationId: newId(),
    lastError: job.verified ? LOCKED_MESSAGE : null,
    updatedAt: now,
    syncedAt: null,
  };
}

const VALUE_FIELDS = ['id', 'areaId', 'product', 'materialQty', 'materialUnit', 'hours', 'crewSize', 'driveMinutes', 'days', 'notes', 'onServer'] as const;

export function sameRows(a: readonly DraftActualRow[], b: readonly DraftActualRow[]): boolean {
  return a.length === b.length && a.every((r, i) => VALUE_FIELDS.every((f) => r[f] === b[i]![f]));
}

/**
 * Merges one job from the server into the stored draft. Returns null when nothing changed.
 * Unsynced values on the phone win (they sync next); otherwise the server's values replace the
 * phone's (another phone or the office may have edited them). A verified job is locked and
 * shows the server's rows (rows the crew cannot see keep what was typed); an unverified one
 * unlocks again.
 */
export function mergeServerJob(
  local: LocalActuals | undefined,
  job: CrewJob,
  ownerId: string,
  newId: () => string,
  now: string,
): LocalActuals | null {
  if (!local) return initialActuals(job, ownerId, newId, now);
  // Once verified, unsynced values can never sync: whatever the server shows wins.
  const rows = reconcileRows(local.rows, job, newId, job.verified || !isUnsynced(local));
  let syncState = local.syncState;
  let lastError = local.lastError;
  if (job.verified) {
    syncState = 'locked';
    lastError = LOCKED_MESSAGE;
  } else if (local.syncState === 'locked') {
    syncState = 'synced';
    lastError = null;
  }
  if (syncState === local.syncState && lastError === local.lastError && sameRows(rows, local.rows)) return null;
  // A new mutation id tells an open form that the stored copy changed underneath it, and keeps
  // the idempotency key tied to exactly what will be sent.
  return { ...local, rows, syncState, lastError, mutationId: newId(), updatedAt: now };
}

/** The form's values (by natural key) for every stored row. */
export function valuesOf(draft: Pick<LocalActuals, 'rows'>): Record<string, RowValues> {
  const out: Record<string, RowValues> = {};
  for (const r of draft.rows) {
    out[naturalKey(r.areaId, r.product)] = {
      materialQty: r.materialQty,
      hours: r.hours,
      crewSize: r.crewSize,
      driveMinutes: r.driveMinutes,
      days: r.days,
      notes: r.notes,
    };
  }
  return out;
}

/**
 * A local edit. Values are applied by natural key onto the stored rows, so ids the stored copy
 * adopted from the server meanwhile are kept. Every edit gets a fresh mutation id. Locked
 * (verified) drafts do not change.
 */
export function applyEdits(current: LocalActuals, values: Record<string, RowValues>, newMutationId: string, now: string): LocalActuals {
  if (current.syncState === 'locked') return current;
  const rows = current.rows.map((r) => {
    const v = values[naturalKey(r.areaId, r.product)];
    return v ? { ...r, ...v } : r;
  });
  return { ...current, rows, mutationId: newMutationId, syncState: 'pending', lastError: null, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/** Rows to send: anything holding a value, plus rows the server has (so clearing a value syncs). */
export function payloadRows(draft: Pick<LocalActuals, 'rows'>): ActualsRow[] {
  return draft.rows
    .filter((r) => r.onServer || rowHasValue(r))
    .map((r) => {
      const jobRow = r.areaId === null || r.product === null;
      return {
        id: r.id,
        areaId: jobRow ? null : r.areaId,
        product: jobRow ? null : r.product,
        materialQty: jobRow ? null : r.materialQty,
        materialUnit: jobRow ? null : r.materialUnit,
        hours: jobRow ? null : r.hours,
        crewSize: jobRow ? r.crewSize : null,
        driveMinutes: jobRow ? r.driveMinutes : null,
        days: jobRow ? r.days : null,
        notes: r.notes?.trim() ? r.notes.trim() : null,
      };
    });
}

/** The request body, checked with the server's own schema so bad input fails on the phone with a clear message. */
export function buildActualsBody(draft: LocalActuals): { ok: true; body: ActualsBody } | { ok: false; error: string } {
  const r = actualsBodySchema.safeParse({ mutationId: draft.mutationId, jobId: draft.jobId, rows: payloadRows(draft) });
  if (r.success) return { ok: true, body: r.data };
  const issue = r.error.issues[0]!;
  const row = typeof issue.path[1] === 'number' ? draft.rows.find((x) => x.id === payloadRows(draft)[issue.path[1] as number]?.id) : undefined;
  const field = typeof issue.path[2] === 'string' ? FIELD_LABELS[issue.path[2]] ?? issue.path[2] : null;
  const where = row ? (row.product ? PRODUCT_LABELS[row.product] : 'Whole job') : null;
  return { ok: false, error: [where, field, issue.message].filter(Boolean).join(': ') };
}

const FIELD_LABELS: Record<string, string> = {
  materialQty: 'Material used',
  hours: 'Person-hours',
  crewSize: 'Crew size',
  driveMinutes: 'Drive minutes',
  days: 'Days on site',
  notes: 'Notes',
};

/**
 * Applies the server's answer to the stored draft. `sent` is what went out: if the crew edited
 * while the request was in flight, the draft has a newer mutation id and stays pending.
 */
export function applyActualsResult(
  current: LocalActuals,
  sent: { mutationId: string; rowIds: readonly string[] },
  res: ActualsSyncResponse,
  now: string,
): LocalActuals {
  const editedSince = current.mutationId !== sent.mutationId;
  switch (res.status) {
    case 'applied': {
      const ids = new Set(sent.rowIds);
      return {
        ...current,
        rows: current.rows.map((r) => (ids.has(r.id) && !r.onServer ? { ...r, onServer: true } : r)),
        syncState: editedSince ? 'pending' : 'synced',
        lastError: null,
        syncedAt: now,
      };
    }
    case 'locked':
      return { ...current, syncState: 'locked', lastError: res.error };
    case 'invalid':
      return editedSince ? { ...current, syncState: 'pending', lastError: null } : { ...current, syncState: 'invalid', lastError: res.error };
    case 'conflict':
    case 'error':
      return { ...current, syncState: 'error', lastError: res.error };
  }
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export interface JobsMergePlan {
  putJobs: LocalJob[];
  deleteJobIds: string[];
  putDrafts: LocalActuals[];
  deleteDraftIds: string[];
}

/**
 * Decides what to store after GET /api/crew/jobs. Every listed job is cached and gets a draft
 * (merged without clobbering unsynced values). Jobs that dropped off the list (older than the
 * window, reassigned, cancelled) are removed unless their draft still has unsynced work.
 */
export function mergeServerJobs(args: {
  jobs: readonly LocalJob[];
  drafts: readonly LocalActuals[];
  server: readonly CrewJob[];
  ownerId: string;
  now: string;
  newId: () => string;
}): JobsMergePlan {
  const { jobs, drafts, server, ownerId, now, newId } = args;
  const listed = new Set(server.map((j) => j.jobId));
  const localJobs = new Map(jobs.map((j) => [j.id, j]));
  const localDrafts = new Map(drafts.map((d) => [d.jobId, d]));
  const plan: JobsMergePlan = { putJobs: [], deleteJobIds: [], putDrafts: [], deleteDraftIds: [] };

  for (const job of server) {
    const cached = localJobs.get(job.jobId);
    if (!cached || cached.ownerId !== ownerId || JSON.stringify(cached.job) !== JSON.stringify(job)) {
      plan.putJobs.push({ id: job.jobId, ownerId, job, fetchedAt: now });
    }
    const merged = mergeServerJob(localDrafts.get(job.jobId), job, ownerId, newId, now);
    if (merged) plan.putDrafts.push(merged);
  }

  for (const id of new Set([...localJobs.keys(), ...localDrafts.keys()])) {
    if (listed.has(id)) continue;
    const draft = localDrafts.get(id);
    if (draft && isUnsynced(draft)) continue;
    if (localJobs.has(id)) plan.deleteJobIds.push(id);
    if (draft) plan.deleteDraftIds.push(id);
  }
  return plan;
}

/** The cached job after a status change the server confirmed. */
export function withStatus(job: CrewJob, s: { status: JobStatus; startedAt: string | null; completedAt: string | null }): CrewJob {
  return { ...job, status: s.status, startedAt: s.startedAt, completedAt: s.completedAt };
}

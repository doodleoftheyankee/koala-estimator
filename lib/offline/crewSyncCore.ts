// Pure decisions for the crew app's offline actuals, separated from IndexedDB/fetch so they can
// be unit tested: which rows a job needs, when they are complete, what to send (only rows the
// crew changed, each with the server version it is based on), how to merge the server's newer
// values field by field, and how to merge a fresh job list without losing unsynced work.
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
import type { ActualValues, DraftActualRow, LocalActuals, LocalJob } from './crewDb';

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
export type RowValues = ActualValues;
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

const VALUE_KEYS = ['materialQty', 'hours', 'crewSize', 'driveMinutes', 'days', 'notes'] as const;
type ValueKey = (typeof VALUE_KEYS)[number];
const NO_VALUES: RowValues = { materialQty: null, hours: null, crewSize: null, driveMinutes: null, days: null, notes: null };

/** Comparable form of one value: notes are compared trimmed, with blank = none. */
const norm = (k: ValueKey, v: RowValues[ValueKey]) => (k === 'notes' ? (typeof v === 'string' && v.trim() ? v.trim() : null) : v);
const pickValues = (r: RowValues): RowValues => ({
  materialQty: r.materialQty,
  hours: r.hours,
  crewSize: r.crewSize,
  driveMinutes: r.driveMinutes,
  days: r.days,
  notes: r.notes,
});

export function emptyRow(id: string, areaId: string | null, product: ProductCode | null, unit: ProductUnit | null): DraftActualRow {
  return { id, areaId, product, ...NO_VALUES, materialUnit: unit, onServer: false, base: null, baseVersion: null, changedElsewhere: null };
}

function fromServer(s: ServerActual, unit: ProductUnit | null): DraftActualRow {
  const values = pickValues(s);
  return {
    id: s.id,
    areaId: s.areaId,
    product: s.product,
    ...values,
    materialUnit: unit,
    onServer: true,
    base: values,
    baseVersion: s.rowVersion,
    changedElsewhere: null,
  };
}

export function rowHasValue(r: RowValues): boolean {
  return r.materialQty !== null || r.hours !== null || r.crewSize !== null || r.driveMinutes !== null || r.days !== null || !!r.notes?.trim();
}

/** Does the row hold something the server does not have yet (a value changed since `base`)? */
export function isDirty(r: Pick<DraftActualRow, ValueKey | 'base'>): boolean {
  if (!r.base) return rowHasValue(r);
  return VALUE_KEYS.some((k) => norm(k, r[k]) !== norm(k, r.base![k]));
}

const FIELD_NAMES: Record<ValueKey, string> = {
  materialQty: 'material used',
  hours: 'person-hours',
  crewSize: 'crew size',
  driveMinutes: 'drive minutes',
  days: 'days on site',
  notes: 'notes',
};
const show = (v: RowValues[ValueKey]) => (v === null ? 'blank' : typeof v === 'string' ? `"${v}"` : String(v));

/**
 * Three-way merge of the phone's row with a newer server row, field by field against what the
 * phone last saw (`base`): a field only the phone changed keeps the phone's value; a field only
 * the server changed takes the server's; a field both changed takes the server's (it was saved
 * first, e.g. the office correcting from an invoice) and the crew is told, with their value, so
 * nothing is lost silently. The result is based on the server row; it is still dirty (and sent
 * again) when it keeps any of the phone's values.
 */
export function mergeRow(mine: DraftActualRow, theirs: ServerActual, unit: ProductUnit | null): DraftActualRow {
  const base = mine.base ?? NO_VALUES;
  const server = pickValues(theirs);
  const merged: RowValues = { ...server };
  const overruled: string[] = [];
  for (const k of VALUE_KEYS) {
    const b = norm(k, base[k]);
    const m = norm(k, mine[k]);
    const t = norm(k, server[k]);
    if (m === b || m === t) continue; // phone did not change it, or both agree: server value
    if (t === b) (merged as Record<ValueKey, unknown>)[k] = mine[k];
    else overruled.push(`${FIELD_NAMES[k]} is ${show(t)} (you had ${show(m)})`);
  }
  return {
    ...mine,
    ...merged,
    id: theirs.id,
    materialUnit: unit,
    onServer: true,
    base: server,
    baseVersion: theirs.rowVersion,
    changedElsewhere: overruled.length
      ? `Saved by someone else while you were editing: ${joinList(overruled)}. Change it again if yours was right.`
      : mine.changedElsewhere,
  };
}

/**
 * Lines the local rows up with the job: one row per expected row (scope order), then rows the
 * server or the phone has beyond the scope. A row the crew has not changed takes the server's
 * values; a changed row keeps the crew's changes, merged with anything the server changed since
 * (mergeRow). `serverWins` (a verified job) discards the phone's changes.
 */
export function reconcileRows(local: readonly DraftActualRow[], job: CrewJob, newId: () => string, serverWins: boolean): DraftActualRow[] {
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
    if (theirs) {
      if (!mine || serverWins || !isDirty(mine)) out.push({ ...fromServer(theirs, unit), changedElsewhere: serverWins ? null : (mine?.changedElsewhere ?? null) });
      else if (mine.baseVersion === theirs.rowVersion) out.push({ ...mine, id: theirs.id, materialUnit: unit, onServer: true });
      else out.push(mergeRow(mine, theirs, unit));
    } else if (mine && (mine.baseVersion === null || isDirty(mine))) {
      // Only on the phone: keep it (it is sent as a new row).
      out.push({ ...mine, materialUnit: unit, onServer: false, base: null, baseVersion: null });
    } else if (exp) {
      // Never entered, or removed on the server without changes here: start empty.
      out.push(emptyRow(newId(), exp.areaId, exp.product, unit));
    }
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

const sameValues = (a: RowValues | null, b: RowValues | null) =>
  a === b || (a !== null && b !== null && VALUE_KEYS.every((k) => a[k] === b[k]));
const ROW_FIELDS = ['id', 'areaId', 'product', ...VALUE_KEYS, 'materialUnit', 'onServer', 'baseVersion', 'changedElsewhere'] as const;

export function sameRows(a: readonly DraftActualRow[], b: readonly DraftActualRow[]): boolean {
  return a.length === b.length && a.every((r, i) => ROW_FIELDS.every((f) => r[f] === b[i]![f]) && sameValues(r.base, b[i]!.base));
}

/**
 * Merges one job from the server into the stored draft. Returns null when nothing changed.
 * Rows the crew changed keep their changes (merged with newer server values); everything else
 * shows the server's values (another phone or the office may have edited them). A verified job
 * is locked and shows the server's rows; an unverified one unlocks again.
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
  const rows = reconcileRows(local.rows, job, newId, job.verified);
  let syncState = local.syncState;
  let lastError = local.lastError;
  if (job.verified) {
    syncState = 'locked';
    lastError = LOCKED_MESSAGE;
  } else if (!rows.some(isDirty)) {
    // Nothing left to send (the server already has it all).
    syncState = 'synced';
    lastError = null;
  } else if (local.syncState === 'locked' || local.syncState === 'synced') {
    syncState = 'pending';
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
  for (const r of draft.rows) out[naturalKey(r.areaId, r.product)] = pickValues(r);
  return out;
}

/**
 * A local edit. Values are applied by natural key onto the stored rows, so ids the stored copy
 * adopted from the server meanwhile are kept. Every edit gets a fresh mutation id; a row the crew
 * changes again drops its "saved by someone else" notice. Locked (verified) drafts do not change.
 */
export function applyEdits(current: LocalActuals, values: Record<string, RowValues>, newMutationId: string, now: string): LocalActuals {
  if (current.syncState === 'locked') return current;
  const rows = current.rows.map((r) => {
    const v = values[naturalKey(r.areaId, r.product)];
    if (!v) return r;
    const edited = VALUE_KEYS.some((k) => norm(k, v[k]) !== norm(k, r[k]));
    return { ...r, ...pickValues(v), changedElsewhere: edited ? null : r.changedElsewhere };
  });
  return { ...current, rows, mutationId: newMutationId, syncState: 'pending', lastError: null, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/** Rows to send: only rows the crew changed since the server's version they are based on. */
export function payloadRows(draft: Pick<LocalActuals, 'rows'>): ActualsRow[] {
  return draft.rows.filter(isDirty).map((r) => {
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
      baseVersion: r.baseVersion,
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

/** What a sent row stored on the server, as row values (job rows carry no qty/hours, area rows no crew data). */
const sentValues = (r: ActualsRow): RowValues => ({
  materialQty: r.materialQty,
  hours: r.hours,
  crewSize: r.crewSize,
  driveMinutes: r.driveMinutes,
  days: r.days,
  notes: r.notes,
});

/**
 * Applies the server's answer to the stored draft. `sent` is what went out: if the crew edited
 * while the request was in flight, the draft has a newer mutation id and stays pending. Saved rows
 * take the server's id and version with what was sent as their new base; conflicting rows are
 * merged (mergeRow) and sent again under a new mutation id (the old one is spent on the server).
 */
export function applyActualsResult(
  current: LocalActuals,
  sent: { mutationId: string; rows: readonly ActualsRow[] },
  res: ActualsSyncResponse,
  now: string,
  newId: () => string,
): LocalActuals {
  const editedSince = current.mutationId !== sent.mutationId;
  switch (res.status) {
    case 'applied': {
      const sentByKey = new Map(sent.rows.map((r) => [naturalKey(r.areaId, r.product), r]));
      const saved = new Map(res.saved.map((r) => [naturalKey(r.areaId, r.product), r]));
      const conflicts = new Map(res.conflicts.map((r) => [naturalKey(r.areaId, r.product), r]));
      const rows = current.rows.map((r) => {
        const key = naturalKey(r.areaId, r.product);
        const s = saved.get(key);
        const out = sentByKey.get(key);
        if (s && out) return { ...r, id: s.id, onServer: true, base: sentValues(out), baseVersion: s.rowVersion };
        const c = conflicts.get(key);
        if (c) return mergeRow(r, c, r.materialUnit);
        return r;
      });
      const more = rows.some(isDirty);
      return {
        ...current,
        rows,
        syncState: editedSince || more ? 'pending' : 'synced',
        mutationId: editedSince || !more ? current.mutationId : newId(),
        lastError: null,
        syncedAt: now,
      };
    }
    case 'locked':
      return { ...current, syncState: 'locked', lastError: res.error };
    case 'invalid':
      return editedSince ? { ...current, syncState: 'pending', lastError: null } : { ...current, syncState: 'invalid', lastError: res.error };
    case 'rejected':
      // The id was spent by another user on this phone: the same change goes again under a new id.
      return { ...current, syncState: 'error', lastError: res.error, mutationId: editedSince ? current.mutationId : newId() };
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

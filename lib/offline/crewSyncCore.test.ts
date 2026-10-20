import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LOCKED_MESSAGE, naturalKey, type CrewJob, type ServerActual } from '@/lib/jobs/crew';
import type { DraftActualRow, LocalActuals, LocalJob } from './crewDb';
import {
  applyActualsResult,
  applyEdits,
  buildActualsBody,
  completionBlockers,
  emptyRow,
  expectedRows,
  initialActuals,
  isUnsynced,
  mergeServerJob,
  mergeServerJobs,
  missingFor,
  payloadRows,
  reconcileRows,
  rowComplete,
  rowHasValue,
  sameRows,
  valuesOf,
  withStatus,
  type RowValues,
} from './crewSyncCore';

const NOW = '2026-10-20T12:00:00.000Z';
const JOB = '11111111-1111-4111-8111-111111111111';
const ATTIC = '22222222-2222-4222-8222-222222222221';
const GARAGE = '22222222-2222-4222-8222-222222222222';

let seq = 0;
const newId = () => `99999999-9999-4999-8999-${String(++seq).padStart(12, '0')}`;

function job(over: Partial<CrewJob> = {}): CrewJob {
  return {
    jobId: JOB,
    status: 'in_progress',
    scheduledStart: '2026-10-20',
    scheduledDays: 2,
    startedAt: '2026-10-20T12:00:00Z',
    completedAt: null,
    address: { street: '9 Elkton Rd', city: 'Newark', zip: '19711', lat: null, lng: null },
    customer: { name: 'Jo Ruiz', phone: '3025550111' },
    signedTier: 'best',
    areas: [
      {
        areaId: ATTIC,
        name: 'Main attic',
        jobType: 'attic',
        sqft: 1200,
        accessLevel: 'difficult',
        removalNeeded: false,
        prepNotes: null,
        hazards: [],
        hazardDisposition: null,
        scope: [
          { product: 'cellulose', kind: 'material', description: 'Blown cellulose', qty: 70, unit: 'bag', hours: null },
          { product: 'cellulose', kind: 'labor', description: 'Install cellulose', qty: 14, unit: 'hour', hours: 14 },
          { product: 'air_sealing', kind: 'labor', description: 'Air sealing labor', qty: 6, unit: 'hour', hours: 6 },
        ],
      },
      {
        areaId: GARAGE,
        name: 'Garage',
        jobType: 'garage',
        sqft: 400,
        accessLevel: 'easy',
        removalNeeded: true,
        prepNotes: 'Move the shelving',
        hazards: ['rodent'],
        hazardDisposition: 'Cleanup first',
        scope: [
          { product: 'removal', kind: 'removal', description: 'Remove existing insulation', qty: 5, unit: 'hour', hours: 5 },
          { product: 'batts', kind: 'material', description: 'R-30 batts', qty: 400, unit: 'sqft', hours: null },
          { product: 'batts', kind: 'labor', description: 'Install batts', qty: 4.25, unit: 'hour', hours: 4.25 },
        ],
      },
    ],
    actuals: [],
    verified: false,
    ...over,
  };
}

function server(over: Partial<ServerActual> & Pick<ServerActual, 'id'>): ServerActual {
  return {
    areaId: ATTIC,
    product: 'cellulose',
    materialQty: null,
    materialUnit: null,
    hours: null,
    crewSize: null,
    driveMinutes: null,
    days: null,
    notes: null,
    enteredAt: NOW,
    ...over,
  };
}

const KEY_CELL = naturalKey(ATTIC, 'cellulose');
const KEY_AIR = naturalKey(ATTIC, 'air_sealing');
const KEY_REMOVAL = naturalKey(GARAGE, 'removal');
const KEY_BATTS = naturalKey(GARAGE, 'batts');

function rowOf(d: Pick<LocalActuals, 'rows'>, key: string): DraftActualRow {
  const r = d.rows.find((x) => naturalKey(x.areaId, x.product) === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
}

function filled(): Record<string, RowValues> {
  const v = (o: Partial<RowValues>): RowValues => ({ materialQty: null, hours: null, crewSize: null, driveMinutes: null, days: null, notes: null, ...o });
  return {
    [KEY_CELL]: v({ materialQty: 75, hours: 15.5, notes: 'two extra bags' }),
    [KEY_AIR]: v({ hours: 6 }),
    [KEY_REMOVAL]: v({ hours: 5.5 }),
    [KEY_BATTS]: v({ materialQty: 410, hours: 4 }),
    job: v({ driveMinutes: 25, days: 2, crewSize: 2 }),
  };
}

describe('expectedRows', () => {
  it('has one row per area x product in scope order, then the job row', () => {
    const rows = expectedRows(job());
    expect(rows.map((r) => r.key)).toEqual([KEY_CELL, KEY_AIR, KEY_REMOVAL, KEY_BATTS, 'job']);
    expect(rows[0]).toMatchObject({ areaName: 'Main attic', label: 'Cellulose', unit: 'bag', estQty: 70, estHours: 14, needsQty: true });
    expect(rows[1]).toMatchObject({ unit: null, estQty: null, estHours: 6, needsQty: false });
    expect(rows[2]).toMatchObject({ product: 'removal', needsQty: false, estHours: 5 });
    expect(rows[3]).toMatchObject({ unit: 'sqft', estQty: 400, estHours: 4.25 });
    expect(rows[4]).toMatchObject({ areaId: null, product: null, label: 'Whole job' });
  });
  it('adds up repeated lines for the same product', () => {
    const j = job();
    j.areas[0]!.scope.push({ product: 'cellulose', kind: 'labor', description: 'More', qty: 1.1, unit: 'hour', hours: 1.1 });
    j.areas[0]!.scope.push({ product: 'cellulose', kind: 'material', description: 'More', qty: null, unit: 'bag', hours: null });
    expect(expectedRows(j)[0]).toMatchObject({ estHours: 15.1, estQty: 70 });
  });
});

describe('completeness', () => {
  it('lists what is missing in plain words', () => {
    const blockers = completionBlockers(job(), []);
    expect(blockers).toEqual([
      'Main attic · Cellulose: enter bags used and person-hours',
      'Main attic · Air sealing: enter person-hours',
      'Garage · Removal of old insulation: enter person-hours',
      'Garage · Fiberglass batts: enter sq ft used and person-hours',
      'Whole job: enter drive minutes, days on site and crew size',
    ]);
  });
  it('is complete once every row has its values (zero counts)', () => {
    const d = applyEdits(initialActuals(job(), 'u1', newId, NOW), filled(), 'm2', NOW);
    expect(completionBlockers(job(), d.rows)).toEqual([]);
    const zeroDrive = applyEdits(d, { job: { ...filled().job!, driveMinutes: 0 } }, 'm3', NOW);
    expect(completionBlockers(job(), zeroDrive.rows)).toEqual([]);
  });
  it('checks single rows', () => {
    const [cell, , , , jobRow] = expectedRows(job());
    expect(rowComplete(cell!, { materialQty: 70, hours: 14 })).toBe(true);
    expect(missingFor(cell!, { hours: 14 })).toEqual(['bags used']);
    expect(missingFor({ ...cell!, unit: null }, undefined)).toEqual(['material used', 'person-hours']);
    expect(missingFor(jobRow!, { driveMinutes: 20, days: 1 })).toEqual(['crew size']);
  });
});

describe('initialActuals', () => {
  it('starts with an empty row per expected row, each with its own id', () => {
    const d = initialActuals(job(), 'u1', newId, NOW);
    expect(d).toMatchObject({ jobId: JOB, ownerId: 'u1', syncState: 'synced', lastError: null });
    expect(d.rows).toHaveLength(5);
    expect(new Set(d.rows.map((r) => r.id)).size).toBe(5);
    expect(d.rows.every((r) => !rowHasValue(r) && !r.onServer)).toBe(true);
    expect(rowOf(d, KEY_CELL).materialUnit).toBe('bag');
  });
  it('adopts what the server already has, and locks verified jobs', () => {
    const s = server({ id: '44444444-4444-4444-8444-444444444441', materialQty: 72, hours: 15 });
    const d = initialActuals(job({ actuals: [s], verified: true }), 'u1', newId, NOW);
    expect(rowOf(d, KEY_CELL)).toMatchObject({ id: s.id, materialQty: 72, hours: 15, onServer: true, materialUnit: 'bag' });
    expect(d.syncState).toBe('locked');
    expect(d.lastError).toBe(LOCKED_MESSAGE);
  });
});

describe('reconcileRows', () => {
  const local = initialActuals(job(), 'u1', newId, NOW);
  const edited = applyEdits(local, filled(), 'm2', NOW);
  const s = server({ id: '44444444-4444-4444-8444-444444444441', materialQty: 60, hours: 10 });

  it('lends the server id but keeps unsynced values', () => {
    const rows = reconcileRows(edited.rows, job({ actuals: [s] }), newId, false);
    expect(rowOf({ rows }, KEY_CELL)).toMatchObject({ id: s.id, materialQty: 75, hours: 15.5, onServer: true });
  });
  it('takes the server values when nothing is unsynced', () => {
    const rows = reconcileRows(edited.rows, job({ actuals: [s] }), newId, true);
    expect(rowOf({ rows }, KEY_CELL)).toMatchObject({ id: s.id, materialQty: 60, hours: 10 });
  });
  it('keeps rows outside the scope from either side', () => {
    const extraServer = server({ id: '44444444-4444-4444-8444-444444444442', product: 'ocsf', hours: 2 });
    const extraLocal: DraftActualRow = { ...emptyRow(newId(), GARAGE, 'ccsf', 'board_ft'), hours: 1 };
    const rows = reconcileRows([...edited.rows, extraLocal], job({ actuals: [extraServer] }), newId, false);
    expect(rows.map((r) => naturalKey(r.areaId, r.product))).toEqual([KEY_CELL, KEY_AIR, KEY_REMOVAL, KEY_BATTS, 'job', naturalKey(ATTIC, 'ocsf'), naturalKey(GARAGE, 'ccsf')]);
  });
});

describe('mergeServerJob', () => {
  it('creates a draft for a new job', () => {
    expect(mergeServerJob(undefined, job(), 'u1', newId, NOW)?.rows).toHaveLength(5);
  });
  it('returns null when nothing changed', () => {
    const d = initialActuals(job(), 'u1', newId, NOW);
    expect(mergeServerJob(d, job(), 'u1', newId, NOW)).toBeNull();
  });
  it('never clobbers unsynced edits, but adopts ids under a new mutation id', () => {
    const d = applyEdits(initialActuals(job(), 'u1', newId, NOW), filled(), 'm2', NOW);
    const s = server({ id: '44444444-4444-4444-8444-444444444441', materialQty: 1, hours: 1 });
    const m = mergeServerJob(d, job({ actuals: [s] }), 'u1', newId, NOW)!;
    expect(m.syncState).toBe('pending');
    expect(valuesOf(m)).toEqual(valuesOf(d));
    expect(rowOf(m, KEY_CELL).id).toBe(s.id);
    expect(m.mutationId).not.toBe('m2');
  });
  it('replaces synced values with the server copy', () => {
    const d = initialActuals(job(), 'u1', newId, NOW);
    const s = server({ id: '44444444-4444-4444-8444-444444444441', materialQty: 80, hours: 16 });
    const m = mergeServerJob(d, job({ actuals: [s] }), 'u1', newId, NOW)!;
    expect(rowOf(m, KEY_CELL)).toMatchObject({ materialQty: 80, hours: 16, onServer: true });
  });
  it('locks on verification and unlocks when the owner unverifies', () => {
    const d = applyEdits(initialActuals(job(), 'u1', newId, NOW), filled(), 'm2', NOW);
    const locked = mergeServerJob(d, job({ verified: true }), 'u1', newId, NOW)!;
    expect(locked).toMatchObject({ syncState: 'locked', lastError: LOCKED_MESSAGE });
    expect(valuesOf(locked)).toEqual(valuesOf(d)); // crews cannot see verified rows; keep what they typed
    // Office and owner do see them: the verified values win over unsynced ones.
    const s = server({ id: '44444444-4444-4444-8444-444444444441', materialQty: 80, hours: 16 });
    expect(rowOf(mergeServerJob(d, job({ verified: true, actuals: [s] }), 'u1', newId, NOW)!, KEY_CELL)).toMatchObject({ materialQty: 80, hours: 16 });
    const unlocked = mergeServerJob(locked, job(), 'u1', newId, NOW)!;
    expect(unlocked).toMatchObject({ syncState: 'synced', lastError: null });
  });
});

describe('applyEdits', () => {
  it('applies values by natural key and keeps ids', () => {
    const d = initialActuals(job(), 'u1', newId, NOW);
    const ids = d.rows.map((r) => r.id);
    const e = applyEdits(d, filled(), 'm2', '2026-10-20T13:00:00.000Z');
    expect(e.rows.map((r) => r.id)).toEqual(ids);
    expect(e).toMatchObject({ mutationId: 'm2', syncState: 'pending', lastError: null, updatedAt: '2026-10-20T13:00:00.000Z' });
    expect(rowOf(e, KEY_CELL)).toMatchObject({ materialQty: 75, hours: 15.5 });
  });
  it('leaves locked drafts alone', () => {
    const d = { ...initialActuals(job(), 'u1', newId, NOW), syncState: 'locked' as const };
    expect(applyEdits(d, filled(), 'm2', NOW)).toBe(d);
  });
});

describe('payload', () => {
  it('sends rows with values and rows the server has, nothing else', () => {
    const d = initialActuals(job(), 'u1', newId, NOW);
    expect(payloadRows(d)).toEqual([]);
    const e = applyEdits(d, { [KEY_CELL]: filled()[KEY_CELL]! }, 'm2', NOW);
    expect(payloadRows(e).map((r) => r.product)).toEqual(['cellulose']);
    // A cleared row the server has is sent so the clear syncs.
    const cleared = { ...e, rows: e.rows.map((r) => (r.product === 'air_sealing' ? { ...r, onServer: true } : r)) };
    expect(payloadRows(cleared).map((r) => r.product)).toEqual(['cellulose', 'air_sealing']);
  });
  it('sends only the fields that belong to each kind of row, with trimmed notes', () => {
    const d = applyEdits(initialActuals(job(), 'u1', newId, NOW), filled(), 'm2', NOW);
    const withStray = { ...d, rows: d.rows.map((r) => (r.areaId === null ? { ...r, hours: 3, notes: '  ' } : { ...r, days: 9, notes: r.notes ? ` ${r.notes} ` : r.notes })) };
    const rows = payloadRows(withStray);
    const jobRow = rows.find((r) => r.areaId === null)!;
    expect(jobRow).toMatchObject({ product: null, hours: null, materialQty: null, crewSize: 2, driveMinutes: 25, days: 2, notes: null });
    const cell = rows.find((r) => r.product === 'cellulose')!;
    expect(cell).toMatchObject({ materialQty: 75, materialUnit: 'bag', days: null, crewSize: null, notes: 'two extra bags' });
  });
  it('builds a body the server schema accepts, or explains the problem', () => {
    const d = applyEdits(initialActuals(job(), 'u1', newId, NOW), filled(), 'm2', NOW);
    const ok = buildActualsBody({ ...d, mutationId: '55555555-5555-4555-8555-555555555555' });
    expect(ok.ok).toBe(true);
    const bad = applyEdits(d, { job: { ...filled().job!, crewSize: 2.5 } }, '55555555-5555-4555-8555-555555555556', NOW);
    expect(buildActualsBody(bad)).toEqual({ ok: false, error: expect.stringMatching(/^Whole job: Crew size: /) });
    const big = applyEdits(d, { [KEY_CELL]: { ...filled()[KEY_CELL]!, hours: 1e6 } }, '55555555-5555-4555-8555-555555555557', NOW);
    expect(buildActualsBody(big)).toEqual({ ok: false, error: expect.stringMatching(/^Cellulose: Person-hours: /) });
    const notUuid = buildActualsBody({ ...d, mutationId: 'm2' });
    expect(notUuid.ok).toBe(false);
  });
});

describe('applyActualsResult', () => {
  const base = applyEdits(initialActuals(job(), 'u1', newId, NOW), filled(), 'm1', NOW);
  const sent = { mutationId: 'm1', rowIds: payloadRows(base).map((r) => r.id) };

  it('marks synced and remembers the server has the rows', () => {
    const r = applyActualsResult(base, sent, { status: 'applied', rows: 5 }, NOW);
    expect(r).toMatchObject({ syncState: 'synced', lastError: null, syncedAt: NOW });
    expect(r.rows.every((x) => x.onServer)).toBe(true);
  });
  it('stays pending if edited while in flight', () => {
    expect(applyActualsResult({ ...base, mutationId: 'm2' }, sent, { status: 'applied', rows: 5 }, NOW).syncState).toBe('pending');
  });
  it('locks when the office verified the job', () => {
    expect(applyActualsResult(base, sent, { status: 'locked', error: LOCKED_MESSAGE }, NOW)).toMatchObject({ syncState: 'locked', lastError: LOCKED_MESSAGE });
  });
  it('needs a fix for invalid data unless it was already edited', () => {
    expect(applyActualsResult(base, sent, { status: 'invalid', error: 'bad' }, NOW)).toMatchObject({ syncState: 'invalid', lastError: 'bad' });
    expect(applyActualsResult({ ...base, mutationId: 'm2' }, sent, { status: 'invalid', error: 'bad' }, NOW)).toMatchObject({ syncState: 'pending', lastError: null });
  });
  it('retries conflicts and transient errors', () => {
    expect(applyActualsResult(base, sent, { status: 'conflict', error: 'elsewhere' }, NOW)).toMatchObject({ syncState: 'error', lastError: 'elsewhere' });
    expect(applyActualsResult(base, sent, { status: 'error', error: 'offline' }, NOW)).toMatchObject({ syncState: 'error' });
    expect(isUnsynced({ syncState: 'error' })).toBe(true);
    expect(isUnsynced({ syncState: 'locked' })).toBe(false);
  });
});

describe('mergeServerJobs', () => {
  const local = (j: CrewJob, ownerId = 'u1'): LocalJob => ({ id: j.jobId, ownerId, job: j, fetchedAt: NOW });
  const OTHER = '11111111-1111-4111-8111-111111111112';

  it('caches new jobs with a draft each', () => {
    const plan = mergeServerJobs({ jobs: [], drafts: [], server: [job()], ownerId: 'u1', now: NOW, newId });
    expect(plan.putJobs).toHaveLength(1);
    expect(plan.putDrafts).toHaveLength(1);
    expect(plan.deleteJobIds).toEqual([]);
  });
  it('writes nothing when nothing changed', () => {
    const j = job();
    const plan = mergeServerJobs({ jobs: [local(j)], drafts: [initialActuals(j, 'u1', newId, NOW)], server: [j], ownerId: 'u1', now: NOW, newId });
    expect(plan).toEqual({ putJobs: [], deleteJobIds: [], putDrafts: [], deleteDraftIds: [] });
  });
  it('re-owns a cached job for the signed-in user and stores status changes', () => {
    const j = job();
    const plan = mergeServerJobs({ jobs: [local(j, 'u0')], drafts: [], server: [withStatus(j, { status: 'completed', startedAt: j.startedAt, completedAt: NOW })], ownerId: 'u1', now: NOW, newId });
    expect(plan.putJobs[0]).toMatchObject({ ownerId: 'u1', job: { status: 'completed', completedAt: NOW } });
  });
  it('drops jobs that left the list unless they hold unsynced work', () => {
    const gone = job({ jobId: OTHER });
    const synced = initialActuals(gone, 'u1', newId, NOW);
    const plan = mergeServerJobs({ jobs: [local(gone)], drafts: [synced], server: [], ownerId: 'u1', now: NOW, newId });
    expect(plan.deleteJobIds).toEqual([OTHER]);
    expect(plan.deleteDraftIds).toEqual([OTHER]);

    const pending = applyEdits(synced, filled(), 'm9', NOW);
    const keep = mergeServerJobs({ jobs: [local(gone)], drafts: [pending], server: [], ownerId: 'u1', now: NOW, newId });
    expect(keep.deleteJobIds).toEqual([]);
    expect(keep.deleteDraftIds).toEqual([]);

    const orphan = mergeServerJobs({ jobs: [], drafts: [synced], server: [], ownerId: 'u1', now: NOW, newId });
    expect(orphan).toMatchObject({ deleteJobIds: [], deleteDraftIds: [OTHER] });
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const KEYS = [KEY_CELL, KEY_AIR, KEY_REMOVAL, KEY_BATTS, 'job'];
const maybe = <T,>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null });
const valuesArb: fc.Arbitrary<RowValues> = fc.record({
  materialQty: maybe(fc.double({ min: 0, max: 5000, noNaN: true })),
  hours: maybe(fc.double({ min: 0, max: 200, noNaN: true })),
  crewSize: maybe(fc.integer({ min: 1, max: 6 })),
  driveMinutes: maybe(fc.double({ min: 0, max: 120, noNaN: true })),
  days: maybe(fc.double({ min: 0, max: 10, noNaN: true })),
  notes: maybe(fc.string({ maxLength: 20 })),
});
const editsArb = fc.dictionary(fc.constantFrom(...KEYS), valuesArb);
const serverArb = fc.uniqueArray(
  fc.record({ key: fc.constantFrom(...KEYS), hours: maybe(fc.double({ min: 0, max: 50, noNaN: true })) }),
  { selector: (s) => s.key, maxLength: 5 },
).map((xs) =>
  xs.map((x, i) => {
    const [areaId, product] = x.key === 'job' ? [null, null] : (x.key.split('|') as [string, ServerActual['product']]);
    return server({ id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`, areaId, product, hours: x.hours });
  }),
);

describe('merge properties', () => {
  it('never loses unsynced values and keeps one row per key', () => {
    fc.assert(
      fc.property(editsArb, serverArb, fc.boolean(), (edits, actuals, verified) => {
        const d = applyEdits(initialActuals(job(), 'u1', newId, NOW), edits, 'm2', NOW);
        const m = mergeServerJob(d, job({ actuals, verified }), 'u1', newId, NOW) ?? d;
        const server = new Set(actuals.map((s) => naturalKey(s.areaId, s.product)));
        for (const [key, v] of Object.entries(valuesOf(d))) {
          // Verified jobs show the server's rows; everything else keeps what the crew typed.
          if (verified && server.has(key)) expect(valuesOf(m)[key]!.hours).toBe(actuals.find((s) => naturalKey(s.areaId, s.product) === key)!.hours);
          else expect(valuesOf(m)[key]).toEqual(v);
        }
        const keys = m.rows.map((r) => naturalKey(r.areaId, r.product));
        expect(new Set(keys).size).toBe(keys.length);
        // Every key the server has uses the server's id.
        for (const s of actuals) expect(rowOf(m, naturalKey(s.areaId, s.product)).id).toBe(s.id);
      }),
    );
  });
  it('is idempotent: merging the same server copy twice changes nothing the second time', () => {
    fc.assert(
      fc.property(editsArb, serverArb, fc.boolean(), fc.boolean(), (edits, actuals, verified, synced) => {
        const start = applyEdits(initialActuals(job(), 'u1', newId, NOW), edits, 'm2', NOW);
        const d = synced ? { ...start, syncState: 'synced' as const } : start;
        const once = mergeServerJob(d, job({ actuals, verified }), 'u1', newId, NOW) ?? d;
        expect(mergeServerJob(once, job({ actuals, verified }), 'u1', newId, NOW)).toBeNull();
        expect(sameRows(once.rows, once.rows)).toBe(true);
      }),
    );
  });
  it('always produces a body the server accepts for in-range values', () => {
    fc.assert(
      fc.property(editsArb, (edits) => {
        const d = applyEdits(initialActuals(job(), 'u1', newId, NOW), edits, '55555555-5555-4555-8555-555555555555', NOW);
        expect(buildActualsBody(d).ok).toBe(true);
      }),
    );
  });
});

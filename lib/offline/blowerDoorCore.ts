// The blower door tool's offline rules, pure so they are unit-tested: which job or estimate the
// tool was opened for, the reading the phone stores and sends, what a sync answer does to it, and
// which readings the screen shows (the server's and the phone's own, never one twice).
import { z } from 'zod';
import { safeNext } from '@/lib/safeNext';
import {
  KIND_LABELS,
  programSnapshot,
  toCfm50,
  type Evaluation,
  type NewTest,
  type RebateProgram,
  type SavedTest,
  type Stories,
  type TestKind,
  type TestSyncResponse,
  testSyncResponseSchema,
} from '@/lib/blowerdoor';

/** Where the readings go: a job (crew, office, owner) or an estimate (estimator). */
export type BlowerDoorContext = { kind: 'job'; id: string; label: string | null } | { kind: 'estimate'; id: string; label: string | null };

/** The key the phone files a context's form and readings under; 'scratch' for the plain calculator. */
export const contextKey = (c: BlowerDoorContext | null) => (c ? `${c.kind}:${c.id}` : 'scratch');

/** ?job=<id> or ?estimate=<id>, with an optional &label= the linking page knew. */
export function parseContextParams(search: string): BlowerDoorContext | null {
  const q = new URLSearchParams(search);
  const label = (q.get('label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  const job = z.guid().safeParse(q.get('job'));
  if (job.success) return { kind: 'job', id: job.data.toLowerCase(), label };
  const est = z.guid().safeParse(q.get('estimate'));
  if (est.success) return { kind: 'estimate', id: est.data.toLowerCase(), label };
  return null;
}

/** The tool's address for a context: a plain link, so the service worker can open it offline. */
export function blowerDoorHref(c: BlowerDoorContext): string {
  const q = new URLSearchParams({ [c.kind]: c.id });
  if (c.label) q.set('label', c.label);
  return `/field/blower-door?${q.toString()}`;
}

/** What a reading says while Koala's database or sign-in service does not answer (L36). */
export const BLOWER_DOOR_UNREACHABLE = "Can't reach Koala right now. The reading is saved on this phone; it is sent when Koala is back.";

/**
 * What the phone makes of the server's answer to one reading (POST /api/blower-door/tests). A 503
 * is Koala's database or sign-in service not answering (L36): not a sign-out and not a refusal; the
 * reading stays on the phone and is sent again on the next sync.
 */
export function testSyncAnswer(status: number, body: unknown): TestSyncResponse | 'signed-out' {
  if (status === 401) return 'signed-out';
  if (status === 503) return { status: 'error', error: BLOWER_DOOR_UNREACHABLE };
  const parsed = testSyncResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : { status: 'error', error: `The server answered ${status}. Will retry.` };
}

/**
 * The sign-in page, coming back to the tool for the same job or estimate afterwards (its typed form
 * and readings are kept per job). next= is only ever a path on this site (lib/safeNext).
 */
export function signInHref(c: BlowerDoorContext | null): string {
  return `/login?next=${encodeURIComponent(safeNext(c ? blowerDoorHref(c) : '/field/blower-door', '/field/blower-door'))}`;
}

export type LocalTestState =
  | 'pending' // waiting to be sent
  | 'waiting' // the estimate has not reached the server yet; sent again on the next sync
  | 'error' // a transient failure; retried
  | 'refused' // not the person's job or estimate right now (it may be given back); retried
  | 'invalid' // values or an id the server will never take; kept on the phone with the reason
  | 'synced';

/** One reading on the phone, from when it is saved until the server's list has it. */
export interface LocalTest {
  id: string;
  ownerId: string;
  contextKey: string;
  test: NewTest;
  /** Who took it, for the screen until the server's copy (with the name) arrives. */
  recordedByName: string;
  mutationId: string;
  syncState: LocalTestState;
  lastError: string | null;
  syncedAt: string | null;
}

/** DB precision (numeric(10,2) CFM and Pa, numeric(4,3) exponent): the reading as it will be stored. */
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export interface NewReadingInput {
  id: string;
  kind: TestKind;
  context: BlowerDoorContext;
  evaluation: Evaluation;
  program: RebateProgram | null;
  form: { stories: Stories };
  recordedAt: string;
  /** The crew never types a price; the office applies the cost cap. */
  includePrice: boolean;
}

/**
 * The reading to store from what is on screen, or null when that test has no usable reading.
 * CFM, pressure and exponent are rounded to what the database keeps, and the CFM50 worked out
 * from those, so the stored CFM50 is exactly the stored reading at its stored exponent.
 */
export function newReading(i: NewReadingInput): NewTest | null {
  const e = i.evaluation;
  const t = i.kind === 'test_in' ? e.testIn : e.testOut;
  if (!t.reading || t.source !== 'typed') return null;
  const cfm = round(t.reading.cfm, 2);
  const pa = round(t.reading.pa, 2);
  const exponent = round(t.reading.exponent, 3);
  const cfm50 = toCfm50(cfm, pa, exponent);
  if (cfm50 === null) return null;
  const basGiven = e.bas.source !== null || e.volume !== null;
  return {
    id: i.id,
    jobId: i.context.kind === 'job' ? i.context.id : null,
    estimateId: i.context.kind === 'estimate' ? i.context.id : null,
    kind: i.kind,
    cfm,
    pa,
    exponent,
    cfm50: round(cfm50, 2),
    programKey: i.program?.key ?? null,
    program: programSnapshot(i.program),
    airSealingCost: i.includePrice && e.cost !== null ? round(e.cost, 2) : null,
    basAudit: e.bas.source === 'audit' ? round(e.bas.value, 1) : null,
    volume: e.volume !== null ? round(e.volume, 1) : null,
    occupants: e.house.occupants,
    stories: basGiven ? i.form.stories : null,
    nFactor: e.bas.source === 'estimated' ? e.house.nFactor : null,
    result: i.kind === 'test_out' ? resultRecord(e) : null,
    recordedAt: i.recordedAt,
  };
}

/** What the phone showed when a test-out was saved, kept with it for the record. */
export function resultRecord(e: Evaluation): Record<string, unknown> {
  return {
    test_in_cfm50: e.testIn.reading?.cfm50 ?? null,
    reduction_pct: e.reductionPct === null ? null : round(e.reductionPct, 2),
    tier_pct: e.tiers?.hit?.reductionPct ?? null,
    tier_rebate: e.rebate?.tierAmount ?? null,
    rebate: e.rebate?.amount ?? null,
    capped: e.rebate?.capped ?? false,
    bas: e.bas.value === null ? null : round(e.bas.value, 1),
    bas_source: e.bas.source,
    ventilation: e.ventilation?.status ?? null,
    ach50_pre: e.ach50Pre === null ? null : round(e.ach50Pre, 2),
    ach50_post: e.ach50Post === null ? null : round(e.ach50Post, 2),
  };
}

/** A reading just saved on the phone. */
export function newLocalTest(test: NewTest, c: BlowerDoorContext, ownerId: string, name: string, mutationId: string): LocalTest {
  return { id: test.id, ownerId, contextKey: contextKey(c), test, recordedByName: name, mutationId, syncState: 'pending', lastError: null, syncedAt: null };
}

/** What a sync answer does to the stored reading. */
export function applyTestResult(local: LocalTest, res: TestSyncResponse, now: string): LocalTest {
  switch (res.status) {
    case 'applied':
      return { ...local, syncState: 'synced', lastError: null, syncedAt: now };
    case 'waiting':
      return { ...local, syncState: 'waiting', lastError: 'Saved on this phone. It goes to the office once this estimate has synced.' };
    case 'error':
      return { ...local, syncState: 'error', lastError: res.error };
    case 'refused':
      // The office may give the job back: the server keeps no record of a refusal, so sending the
      // reading again later is safe.
      return { ...local, syncState: 'refused', lastError: res.error };
    default:
      return { ...local, syncState: 'invalid', lastError: res.error };
  }
}

/** Readings the phone still sends (a refused one too: the job may be given back). */
export const isUnsent = (t: Pick<LocalTest, 'syncState'>) => t.syncState === 'pending' || t.syncState === 'waiting' || t.syncState === 'error' || t.syncState === 'refused';

/** A reading on screen: the server's copy, or the phone's own until the server has it. */
export interface ShownReading {
  test: SavedTest;
  /** The phone's copy (not on the server yet, or the server's list is older than the save). */
  local: LocalTest | null;
}

/** A phone reading in the server's shape. */
export function asSaved(l: LocalTest, ownerId: string): SavedTest {
  const t = l.test;
  return {
    id: t.id,
    job_id: t.jobId,
    estimate_id: t.estimateId ?? '',
    kind: t.kind,
    cfm: t.cfm,
    pa: t.pa,
    exponent: t.exponent,
    cfm50: t.cfm50,
    program_key: t.programKey,
    program: t.program,
    air_sealing_cost: t.airSealingCost,
    bas_audit: t.basAudit,
    volume: t.volume,
    occupants: t.occupants,
    stories: t.stories === null ? null : Number(t.stories),
    n_factor: t.nFactor,
    recorded_by: ownerId,
    recorded_by_name: l.recordedByName,
    recorded_at: t.recordedAt,
  };
}

/** The server's readings and the phone's own, one each (the server's copy wins), newest first. */
export function mergeReadings(server: readonly SavedTest[], local: readonly LocalTest[]): ShownReading[] {
  const byId = new Map<string, ShownReading>();
  for (const s of server) byId.set(s.id, { test: s, local: null });
  for (const l of local) if (!byId.has(l.id)) byId.set(l.id, { test: asSaved(l, l.ownerId), local: l });
  return [...byId.values()].sort((a, b) => b.test.recorded_at.localeCompare(a.test.recorded_at));
}

/** The newest shown reading of a kind. */
export const newestOf = (shown: readonly ShownReading[], kind: TestKind) => shown.find((r) => r.test.kind === kind) ?? null;

/**
 * Lines for the copied summary about the readings it uses that the office does not have: still on
 * the phone (offline, or refused for now and sent again), or not saved at all.
 */
export function unsentNotes(used: ReadonlyArray<ShownReading | null>): string[] {
  const notes: string[] = [];
  for (const r of used) {
    if (!r?.local || r.local.syncState === 'synced') continue;
    const what = KIND_LABELS[r.test.kind].toLowerCase();
    notes.push(
      r.local.syncState === 'invalid'
        ? `Note: the ${what} was not saved to the office: ${r.local.lastError ?? 'the server refused it.'}`
        : `Note: the ${what} is saved on this phone only; it has not reached the office yet.`,
    );
  }
  return notes;
}

/** Phone copies the server's list now has: safe to drop. */
export function settledLocalIds(server: readonly SavedTest[], local: readonly LocalTest[]): string[] {
  const ids = new Set(server.map((s) => s.id));
  return local.filter((l) => l.syncState === 'synced' && ids.has(l.id)).map((l) => l.id);
}

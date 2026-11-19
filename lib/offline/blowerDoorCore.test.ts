import { describe, expect, it } from 'vitest';
import { SEEDED } from '@/lib/blowerdoor/__fixtures__/settings';
import { emptyForm, evaluate, newTestSchema, parseBlowerDoorSettings, toCfm50, type BlowerDoorForm, type SavedTest } from '@/lib/blowerdoor';
import {
  applyTestResult,
  BLOWER_DOOR_UNREACHABLE,
  blowerDoorHref,
  contextKey,
  isUnsent,
  mergeReadings,
  newestOf,
  newLocalTest,
  newReading,
  parseContextParams,
  settledLocalIds,
  signInHref,
  testSyncAnswer,
  unsentNotes,
  type BlowerDoorContext,
  type LocalTest,
} from './blowerDoorCore';

const SETTINGS = parseBlowerDoorSettings(SEEDED).settings;
const JOB = '0b000000-0000-4000-8000-000000000001';
const EST = '0e000000-0000-4000-8000-000000000001';
const ME = '0c000000-0000-4000-8000-000000000001';
const JOB_CTX: BlowerDoorContext = { kind: 'job', id: JOB, label: 'Pat Lee, 12 Elkton Rd' };
const EST_CTX: BlowerDoorContext = { kind: 'estimate', id: EST, label: null };

const typed = (patch: Partial<BlowerDoorForm>) => {
  const form = { ...emptyForm(SETTINGS), preCfm: '6952', postCfm: '3325', postPa: '50.8', ...patch };
  return { form, e: evaluate({ form, settings: SETTINGS }) };
};

describe('where the tool was opened from', () => {
  it('reads ?job= or ?estimate= with an optional label, and nothing else', () => {
    expect(parseContextParams(`?job=${JOB}&label=Pat%20Lee,%20%2012%20Elkton%20Rd`)).toEqual({ kind: 'job', id: JOB, label: 'Pat Lee, 12 Elkton Rd' });
    expect(parseContextParams(`?estimate=${EST.toUpperCase()}`)).toEqual({ kind: 'estimate', id: EST, label: null });
    expect(parseContextParams('?job=not-a-uuid')).toBeNull();
    expect(parseContextParams('')).toBeNull();
    expect(parseContextParams(`?job=${JOB}&label=${'x'.repeat(500)}`)!.label).toHaveLength(120);
  });

  it('links to the tool with a plain URL the service worker can open offline', () => {
    expect(blowerDoorHref(JOB_CTX)).toBe(`/field/blower-door?job=${JOB}&label=Pat+Lee%2C+12+Elkton+Rd`);
    expect(blowerDoorHref(EST_CTX)).toBe(`/field/blower-door?estimate=${EST}`);
    expect(parseContextParams(blowerDoorHref(JOB_CTX).split('?')[1]!)).toEqual(JOB_CTX);
    expect(contextKey(JOB_CTX)).toBe(`job:${JOB}`);
    expect(contextKey(null)).toBe('scratch');
  });
});

describe('the reading the phone saves', () => {
  it('is the typed test at the database precision, with a CFM50 the server accepts', () => {
    const { form, e } = typed({ volume: '20,000', occupants: '3', cost: '2000' });
    const t = newReading({ id: '0d000000-0000-4000-8000-000000000001', kind: 'test_out', context: JOB_CTX, evaluation: e, program: e.program, form, recordedAt: '2026-11-19T15:00:00.000Z', includePrice: true })!;
    expect(t).toMatchObject({ jobId: JOB, estimateId: null, kind: 'test_out', cfm: 3325, pa: 50.8, exponent: 0.65, cfm50: 3290.87, programKey: 'home_performance', airSealingCost: 2000, volume: 20000, occupants: 3, stories: '2', nFactor: 19, basAudit: null });
    expect(t.program).toMatchObject({ key: 'home_performance', tiers: [{ reduction_pct: 20, rebate: 900 }, { reduction_pct: 30, rebate: 1300 }, { reduction_pct: 40, rebate: 1800 }] });
    expect(t.result).toMatchObject({ test_in_cfm50: 6952, tier_pct: 40, tier_rebate: 1800, rebate: 1500, capped: true, bas_source: 'estimated', ventilation: 'ok' });
    expect(newTestSchema.safeParse(t).success).toBe(true);
  });

  it('rounds a long typed value before working the CFM50 out, so the stored CFM50 matches the stored reading', () => {
    // A fourth decimal of the exponent is refused now (BD-MATH-6, below); three are kept.
    const { form, e } = typed({ preCfm: '4012.3456', prePa: '-37.777', exponent: '0.654' });
    const t = newReading({ id: '0d000000-0000-4000-8000-000000000002', kind: 'test_in', context: EST_CTX, evaluation: e, program: null, form, recordedAt: '2026-11-19T15:00:00.000Z', includePrice: true })!;
    expect([t.cfm, t.pa, t.exponent]).toEqual([4012.35, 37.78, 0.654]);
    expect(Math.abs(t.cfm50 - toCfm50(4012.35, 37.78, 0.654)!)).toBeLessThanOrEqual(0.005);
    expect(t).toMatchObject({ estimateId: EST, jobId: null, programKey: null, program: null, result: null, stories: null, volume: null });
  });

  it('never keeps a price for a crew', () => {
    const { form, e } = typed({ cost: '2000' });
    const t = newReading({ id: '0d000000-0000-4000-8000-000000000003', kind: 'test_out', context: JOB_CTX, evaluation: e, program: e.program, form, recordedAt: '2026-11-19T15:00:00.000Z', includePrice: false })!;
    expect(t.airSealingCost).toBeNull();
  });

  it('keeps the BAS from the audit when given', () => {
    const { form, e } = typed({ bas: '2500', volume: '20000' });
    const t = newReading({ id: '0d000000-0000-4000-8000-000000000004', kind: 'test_out', context: JOB_CTX, evaluation: e, program: e.program, form, recordedAt: '2026-11-19T15:00:00.000Z', includePrice: true })!;
    expect(t).toMatchObject({ basAudit: 2500, volume: 20000, nFactor: null });
  });

  it('is nothing when that test has no usable reading, or shows a saved one', () => {
    const { form, e } = typed({ postCfm: '0' });
    expect(newReading({ id: 'x', kind: 'test_out', context: JOB_CTX, evaluation: e, program: null, form, recordedAt: '', includePrice: true })).toBeNull();
    const saved = evaluate({ form, settings: SETTINGS, savedIn: { cfm: 1, pa: 50, exponent: 0.65, cfm50: 1 } });
    expect(newReading({ id: 'x', kind: 'test_in', context: JOB_CTX, evaluation: saved, program: null, form, recordedAt: '', includePrice: true })).toBeNull();
  });
});

const local = (id: string, kind: 'test_in' | 'test_out', at: string, patch: Partial<LocalTest> = {}): LocalTest => {
  const { form, e } = typed({});
  const t = newReading({ id, kind, context: JOB_CTX, evaluation: e, program: e.program, form, recordedAt: at, includePrice: true })!;
  return { ...newLocalTest(t, JOB_CTX, ME, 'Carl Crew', `m-${id}`), ...patch };
};

describe('a sync answer', () => {
  const t = local('0d000000-0000-4000-8000-0000000000a1', 'test_out', '2026-11-19T15:00:00.000Z');
  const now = '2026-11-19T15:05:00.000Z';

  it('marks the reading synced, waiting, retried or refused, and keeps it on the phone', () => {
    expect(t).toMatchObject({ syncState: 'pending', contextKey: `job:${JOB}`, ownerId: ME });
    expect(applyTestResult(t, { status: 'applied', id: t.id, recorded_at: now }, now)).toMatchObject({ syncState: 'synced', lastError: null, syncedAt: now });
    expect(applyTestResult(t, { status: 'waiting' }, now)).toMatchObject({ syncState: 'waiting', lastError: 'Saved on this phone. It goes to the office once this estimate has synced.' });
    expect(applyTestResult(t, { status: 'error', error: 'No signal.' }, now)).toMatchObject({ syncState: 'error', lastError: 'No signal.' });
    // Refused (not the caller's job right now) is tried again on later syncs (BD-R7).
    expect(applyTestResult(t, { status: 'refused', error: 'This job is not assigned to your crew.' }, now)).toMatchObject({ syncState: 'refused', lastError: 'This job is not assigned to your crew.' });
    expect(applyTestResult(t, { status: 'invalid', error: 'x' }, now).syncState).toBe('invalid');
    expect(applyTestResult(t, { status: 'rejected', error: 'x' }, now).syncState).toBe('invalid');
  });

  it('sends again only what can still go: pending, waiting and failed readings', () => {
    expect(['pending', 'waiting', 'error', 'refused', 'invalid', 'synced'].filter((s) => isUnsent({ syncState: s as LocalTest['syncState'] }))).toEqual(['pending', 'waiting', 'error', 'refused']);
  });
});

describe('the readings on screen', () => {
  const server = (id: string, kind: 'test_in' | 'test_out', at: string): SavedTest => ({
    id,
    job_id: kind === 'test_out' ? JOB : null,
    estimate_id: EST,
    kind,
    cfm: 6952,
    pa: 50,
    exponent: 0.65,
    cfm50: 6952,
    program_key: null,
    program: null,
    air_sealing_cost: null,
    bas_audit: null,
    volume: 20000,
    occupants: null,
    stories: null,
    n_factor: null,
    recorded_by: ME,
    recorded_by_name: 'Erin Estimator',
    recorded_at: at,
  });

  it("shows the server's copy and the phone's own once each, newest first", () => {
    const sIn = server('0d000000-0000-4000-8000-0000000000b1', 'test_in', '2026-11-02T14:00:00+00:00');
    const sent = local('0d000000-0000-4000-8000-0000000000b2', 'test_out', '2026-11-19T14:00:00.000Z', { syncState: 'synced' });
    const sentOnServer = server(sent.id, 'test_out', '2026-11-19T14:00:00+00:00');
    const offline = local('0d000000-0000-4000-8000-0000000000b3', 'test_out', '2026-11-19T15:00:00.000Z');
    const shown = mergeReadings([sentOnServer, sIn], [sent, offline]);
    expect(shown.map((r) => [r.test.id, r.local?.syncState ?? 'server'])).toEqual([
      [offline.id, 'pending'],
      [sent.id, 'server'],
      [sIn.id, 'server'],
    ]);
    expect(newestOf(shown, 'test_out')!.test.id).toBe(offline.id);
    expect(newestOf(shown, 'test_out')!.test.recorded_by_name).toBe('Carl Crew');
    expect(newestOf(shown, 'test_in')!.test.recorded_by_name).toBe('Erin Estimator');
    expect(settledLocalIds([sentOnServer, sIn], [sent, offline])).toEqual([sent.id]);
  });

  it('keeps a synced reading the server list does not have yet', () => {
    const sent = local('0d000000-0000-4000-8000-0000000000c1', 'test_in', '2026-11-19T14:00:00.000Z', { syncState: 'synced' });
    expect(mergeReadings([], [sent]).map((r) => r.test.id)).toEqual([sent.id]);
    expect(settledLocalIds([], [sent])).toEqual([]);
  });
});

describe('review fixes', () => {
  it('saves the CFM50 the screen showed (BD-MATH-6)', () => {
    const { form, e } = typed({ preCfm: '6000', prePa: '25', postCfm: '4000', postPa: '25', exponent: '0.653' });
    const t = newReading({ id: '0d000000-0000-4000-8000-0000000000f1', kind: 'test_out', context: JOB_CTX, evaluation: e, program: e.program, form, recordedAt: '2026-11-19T15:00:00.000Z', includePrice: true })!;
    expect(t.exponent).toBe(0.653);
    expect(Math.abs(t.cfm50 - e.testOut.reading!.cfm50)).toBeLessThanOrEqual(0.005);
    // 0.6525 is refused on screen, so nothing different can be saved.
    const four = typed({ preCfm: '6000', prePa: '25', postCfm: '4000', postPa: '25', exponent: '0.6525' });
    expect(newReading({ id: 'x', kind: 'test_out', context: JOB_CTX, evaluation: four.e, program: null, form: four.form, recordedAt: '', includePrice: true })).toBeNull();
  });

  it('a refused reading is sent again, and the summary says it has not reached the office (BD-R7)', () => {
    const t = local('0d000000-0000-4000-8000-0000000000f2', 'test_out', '2026-11-19T15:00:00.000Z');
    const refused = applyTestResult(t, { status: 'refused', error: 'This job is not assigned to your crew.' }, '2026-11-19T15:05:00.000Z');
    expect(isUnsent(refused)).toBe(true);
    const shown = mergeReadings([], [refused]);
    expect(unsentNotes([null, newestOf(shown, 'test_out')])).toEqual(['Note: the test-out is saved on this phone only; it has not reached the office yet.']);
    const invalid = applyTestResult(t, { status: 'invalid', error: 'The reading is outside what a gauge can show.' }, '2026-11-19T15:05:00.000Z');
    expect(unsentNotes([newestOf(mergeReadings([], [invalid]), 'test_out')])).toEqual(['Note: the test-out was not saved to the office: The reading is outside what a gauge can show.']);
    const synced = { ...t, syncState: 'synced' as const };
    expect(unsentNotes([newestOf(mergeReadings([], [synced]), 'test_out')])).toEqual([]);
  });
});

// Release, "blower door under the accuracy rules" (L36, review B flow-B10, database-B1).
describe('Koala unreachable is not a sign-out, and the sign-in link keeps the job', () => {
  const UNREACHABLE = { error: 'unreachable', message: "Can't reach Koala right now. Your work is saved. Try again in a minute." };

  it("a 503 from Koala says \"Can't reach Koala right now\" and keeps the reading to send again (was \"The server answered 503\")", () => {
    const a = testSyncAnswer(503, UNREACHABLE);
    expect(a).toEqual({ status: 'error', error: "Can't reach Koala right now. The reading is saved on this phone; it is sent when Koala is back." });
    expect(a).toEqual({ status: 'error', error: BLOWER_DOOR_UNREACHABLE });
    const kept = applyTestResult(local('0d000000-0000-4000-8000-0000000000b1', 'test_out', '2026-11-19T15:00:00.000Z'), a as never, '2026-11-19T15:05:00.000Z');
    expect(kept.syncState).toBe('error');
    expect(isUnsent(kept)).toBe(true);
    // The same for the page's 503 without a body (a proxy in between).
    expect(testSyncAnswer(503, null)).toEqual({ status: 'error', error: BLOWER_DOOR_UNREACHABLE });
  });

  it('a 401 is a sign-out; a refusal and a stored reading are as the server says; anything else is retried', () => {
    expect(testSyncAnswer(401, { error: 'Not signed in' })).toBe('signed-out');
    expect(testSyncAnswer(200, { status: 'applied', id: JOB, recorded_at: '2026-11-19T15:00:00Z' })).toEqual({ status: 'applied', id: JOB, recorded_at: '2026-11-19T15:00:00Z' });
    expect(testSyncAnswer(403, { status: 'refused', error: 'Not your job.' })).toEqual({ status: 'refused', error: 'Not your job.' });
    expect(testSyncAnswer(500, { error: 'boom' })).toEqual({ status: 'error', error: 'The server answered 500. Will retry.' });
  });

  it('"Sign in again" comes back to the same job or estimate, through safeNext (was /field/blower-door, the plain calculator)', () => {
    expect(signInHref(JOB_CTX)).toBe(`/login?next=${encodeURIComponent(`/field/blower-door?job=${JOB}&label=Pat+Lee%2C+12+Elkton+Rd`)}`);
    expect(signInHref(EST_CTX)).toBe(`/login?next=${encodeURIComponent(`/field/blower-door?estimate=${EST}`)}`);
    expect(signInHref(null)).toBe(`/login?next=${encodeURIComponent('/field/blower-door')}`);
  });
});

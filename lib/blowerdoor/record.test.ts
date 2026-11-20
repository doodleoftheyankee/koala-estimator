import { describe, expect, it } from 'vitest';
import { SEEDED } from './__fixtures__/settings';
import { capNote, headlineWords, jobBlowerDoor, latestReadings, newTestSchema, parseBlowerDoorSettings, programSnapshot, savedProgramKey, savedTestSchema, toCfm50, toRpcTest, ventilationWords, type SavedTest } from './index';

const SETTINGS = parseBlowerDoorSettings(SEEDED).settings;
const PROGRAM = SETTINGS.programs[0]!;
const ASSISTED = SETTINGS.programs[1]!;
const JOB = '0b000000-0000-4000-8000-000000000001';
const EST = '0e000000-0000-4000-8000-000000000001';

const newTest = (patch: Record<string, unknown> = {}) => ({
  id: '0d000000-0000-4000-8000-000000000001',
  jobId: JOB,
  estimateId: null,
  kind: 'test_out',
  cfm: 3325,
  pa: 50.8,
  exponent: 0.65,
  cfm50: toCfm50(3325, 50.8, 0.65),
  programKey: 'home_performance',
  program: programSnapshot(PROGRAM),
  recordedAt: '2026-11-19T15:04:00.000Z',
  ...patch,
});

describe('a reading the phone sends', () => {
  it('is accepted with its program and turned into the RPC payload', () => {
    const r = newTestSchema.safeParse(newTest({ volume: 20000, stories: '1.5', occupants: 3 }));
    expect(r.success).toBe(true);
    const rpc = toRpcTest(r.data!);
    expect(rpc).toMatchObject({ job_id: JOB, estimate_id: null, kind: 'test_out', program_key: 'home_performance', stories: 1.5, occupants: 3, bas_audit: null, n_factor: null });
    expect((rpc.program as { tiers: unknown[] }).tiers).toHaveLength(3);
  });

  it('is refused when the CFM50 does not match the reading and its exponent', () => {
    const r = newTestSchema.safeParse(newTest({ cfm50: 3325 }));
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain('The CFM50 does not match the reading.');
    // Rounded on the phone to a whole CFM is fine.
    expect(newTestSchema.safeParse(newTest({ cfm50: 3291 })).success).toBe(true);
  });

  it('belongs to a job or an estimate, not both or neither', () => {
    expect(newTestSchema.safeParse(newTest({ jobId: JOB, estimateId: EST })).success).toBe(false);
    expect(newTestSchema.safeParse(newTest({ jobId: null, estimateId: null })).success).toBe(false);
    expect(newTestSchema.safeParse(newTest({ jobId: null, estimateId: EST, kind: 'test_in' })).success).toBe(true);
  });

  it('is refused with readings no gauge gives', () => {
    for (const patch of [{ cfm: 0 }, { pa: 0 }, { pa: 400 }, { exponent: 1.4 }, { occupants: 2.5 }, { volume: 3 }, { kind: 'test_middle' }, { recordedAt: 'yesterday' }]) {
      expect(newTestSchema.safeParse(newTest(patch)).success, JSON.stringify(patch)).toBe(false);
    }
  });
});

const saved = (patch: Partial<SavedTest> & Pick<SavedTest, 'id' | 'kind'>): SavedTest =>
  savedTestSchema.parse({
    job_id: JOB,
    estimate_id: EST,
    cfm: '6952',
    pa: '50',
    exponent: '0.65',
    cfm50: '6952',
    program_key: 'home_performance',
    program: programSnapshot(PROGRAM),
    air_sealing_cost: null,
    bas_audit: null,
    volume: null,
    occupants: null,
    stories: null,
    n_factor: null,
    recorded_by: '0c000000-0000-4000-8000-000000000001',
    recorded_by_name: 'Carl Crew',
    recorded_at: '2026-11-01T14:00:00+00:00',
    ...patch,
  });

describe("the job's readings", () => {
  const testIn = saved({ id: '0d000000-0000-4000-8000-0000000000a1', kind: 'test_in', job_id: null, volume: 20000, occupants: 3, stories: 2 });
  const oldOut = saved({ id: '0d000000-0000-4000-8000-0000000000a2', kind: 'test_out', cfm: 5000, cfm50: 5000, recorded_at: '2026-11-18T14:00:00+00:00' });
  const testOut = saved({ id: '0d000000-0000-4000-8000-0000000000a3', kind: 'test_out', cfm: 3325, pa: 50.8, cfm50: 3290.87, recorded_at: '2026-11-19T14:00:00+00:00', air_sealing_cost: 2000 });

  it('counts the newest of each kind; the rest are earlier readings', () => {
    const l = latestReadings([testIn, testOut, oldOut]);
    expect(l.testIn!.id).toBe(testIn.id);
    expect(l.testOut!.id).toBe(testOut.id);
    expect(l.earlier.map((r) => r.id)).toEqual([oldOut.id]);
  });

  it('works the result out from the readings as recorded, with the program saved with them', () => {
    const j = jobBlowerDoor([oldOut, testIn, testOut], 'Retrotec Model 5000');
    const e = j.evaluation!;
    expect(e.testOut.reading!.cfm50).toBe(3290.87);
    expect(e.reductionPct).toBeCloseTo(52.66, 2);
    // The price given with the test-out caps the rebate: 75% of $2,000.
    expect(headlineWords(e).badge).toBe('40% TIER — $1,500 AIR SEAL REBATE');
    // The volume and people from the estimator's test-in give the BAS.
    expect(e.bas.source).toBe('estimated');
    expect(ventilationWords(e.ventilation!, e.bas.value!, e.bas, e.program).tone).toBe('ok');
    expect(e.ach50Post).toBeCloseTo((3290.87 * 60) / 20000, 9);
  });

  it('keeps a saved CFM50 even when the stored exponent would give another', () => {
    const odd = saved({ id: '0d000000-0000-4000-8000-0000000000a4', kind: 'test_out', cfm: 3000, pa: 40, exponent: 0.6, cfm50: 3428.1, recorded_at: '2026-11-20T14:00:00+00:00' });
    expect(jobBlowerDoor([testIn, odd], 'G').evaluation!.testOut.reading!.cfm50).toBe(3428.1);
  });

  it('has the test-in alone before the work, and nothing with no readings', () => {
    expect(jobBlowerDoor([testIn], 'G').evaluation!.headline).toEqual({ kind: 'test-in-only', pre50: 6952 });
    expect(jobBlowerDoor([], 'G').evaluation).toBeNull();
  });

  it('still shows the reduction when the saved program is missing', () => {
    const bare = { ...testOut, program: null };
    const j = jobBlowerDoor([{ ...testIn, program: null }, bare], 'G');
    expect(j.evaluation!.headline.kind).toBe('no-program');
  });
});

describe("the job's price and program, whoever took each reading", () => {
  const ESTIMATOR = '0c000000-0000-4000-8000-0000000000e1';
  // The estimator saves the test-in on the estimate, under Assisted, with the air sealing price.
  const estIn = saved({
    id: '0d000000-0000-4000-8000-0000000000d1',
    kind: 'test_in',
    job_id: null,
    program_key: 'assisted',
    program: programSnapshot(ASSISTED),
    air_sealing_cost: 1999,
    recorded_by: ESTIMATOR,
    recorded_by_name: 'Eddie Estimator',
  });
  // The crew saves the test-out on the job: crews never send a price.
  const crewOut = (program = ASSISTED, at = '2026-11-19T14:00:00+00:00', id = '0d000000-0000-4000-8000-0000000000d2') =>
    saved({ id, kind: 'test_out', cfm: 3325, pa: 50.8, cfm50: 3290.87, program_key: program.key, program: programSnapshot(program), recorded_at: at });

  it('applies the cost cap from the price the estimator saved with the test-in (BD-MATH-1)', () => {
    const e = jobBlowerDoor([estIn, crewOut()], 'G').evaluation!;
    expect(e.cost).toBe(1999);
    expect(headlineWords(e).badge).toBe('40% TIER — $1,499 AIR SEAL REBATE');
    expect(capNote(e)).toBe(' (limited by 75% of $1,999)');
  });

  it('keeps the newest price when a later reading has none, and takes a newer one over it', () => {
    const officeOut = { ...crewOut(ASSISTED, '2026-11-19T13:00:00+00:00', '0d000000-0000-4000-8000-0000000000d3'), air_sealing_cost: 2200 };
    expect(jobBlowerDoor([estIn, officeOut, crewOut()], 'G').evaluation!.cost).toBe(2200);
    expect(jobBlowerDoor([estIn, crewOut(PROGRAM)], 'G').evaluation!.rebate).toMatchObject({ amount: 1499, capped: true });
  });

  it("picks the program the readings were saved under for the crew's phone (BD-MATH-2)", () => {
    expect(savedProgramKey([estIn], SETTINGS)).toBe('assisted');
    // The newest reading's program counts; one that no longer exists is skipped.
    expect(savedProgramKey([estIn, crewOut(PROGRAM)], SETTINGS)).toBe('home_performance');
    expect(savedProgramKey([estIn, { ...crewOut(), program_key: 'gone' }], SETTINGS)).toBe('assisted');
    expect(savedProgramKey([], SETTINGS)).toBeNull();
    expect(savedProgramKey([{ ...estIn, program_key: null }], SETTINGS)).toBeNull();
  });

  it('warns when the test-in and the test-out were saved under different programs (BD-R2)', () => {
    const same = jobBlowerDoor([estIn, crewOut()], 'G');
    expect(same.programMismatch).toBeNull();
    expect(headlineWords(same.evaluation!).badge).toBe('40% TIER — $1,499 AIR SEAL REBATE');
    const differ = jobBlowerDoor([estIn, crewOut(PROGRAM)], 'G');
    expect(differ.programMismatch).toEqual({ testIn: 'Assisted', testOut: 'Home Performance' });
    // The result still uses the program saved with the test-out.
    expect(differ.evaluation!.program!.key).toBe('home_performance');
  });

  it('decides on whole CFM50 when the franchise says so', () => {
    const near = saved({ id: '0d000000-0000-4000-8000-0000000000d4', kind: 'test_out', cfm: 5576, pa: 50.2, cfm50: 5561.55 });
    const testIn = saved({ id: '0d000000-0000-4000-8000-0000000000d5', kind: 'test_in', job_id: null });
    expect(headlineWords(jobBlowerDoor([testIn, near], 'G').evaluation!).badge).toBe('20% TIER — UP TO $900 AIR SEAL REBATE');
    expect(headlineWords(jobBlowerDoor([testIn, near], 'G', { wholeCfm50: true }).evaluation!).badge).toBe('BELOW 20% — NO AIR SEAL REBATE YET');
  });
});

describe('release review C FLOW-1: the office card never gives the bare tier amount as the rebate when no price was saved', () => {
  // A signed job with no estimator test-in: the crew took both readings, neither with a price.
  const crewIn = saved({ id: '0d000000-0000-4000-8000-0000000000f1', kind: 'test_in', cfm: 4800, cfm50: 4800 });
  const crewOut = saved({ id: '0d000000-0000-4000-8000-0000000000f2', kind: 'test_out', cfm: 3500, cfm50: 3500, recorded_at: '2026-11-19T14:00:00+00:00' });

  it('no price with either reading: "up to $900", before the 75% cost cap', async () => {
    const words = (await import('./index')) as Record<string, unknown>;
    expect(words.officeTierFact, 'officeTierFact').toBeTypeOf('function');
    const tierFact = words.officeTierFact as (e: unknown) => string;
    const e = jobBlowerDoor([crewIn, crewOut], 'G').evaluation!;
    expect(e.cost).toBeNull();
    expect(headlineWords(e).badge).toBe('20% TIER — UP TO $900 AIR SEAL REBATE');
    expect(tierFact(e)).toBe('20% tier · up to $900 (before the 75% cost cap: no air sealing price saved)');
    expect(tierFact(e)).toMatch(/75% cost cap/);
  });

  it('with the price saved, the capped amount: $516, limited by 75% of $688', async () => {
    const { officeTierFact } = (await import('./index')) as unknown as { officeTierFact: (e: unknown) => string };
    const e = jobBlowerDoor([crewIn, { ...crewOut, air_sealing_cost: 688 }], 'G').evaluation!;
    expect(headlineWords(e).badge).toBe('20% TIER — $516 AIR SEAL REBATE');
    expect(officeTierFact(e)).toBe('20% tier · $516 (limited by 75% of $688)');
    expect(capNote(e)).toBe(' (limited by 75% of $688)');
  });
});

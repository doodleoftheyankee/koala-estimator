import { describe, expect, it } from 'vitest';
import { SEEDED } from './__fixtures__/settings';
import { headlineWords, jobBlowerDoor, latestReadings, newTestSchema, parseBlowerDoorSettings, programSnapshot, savedTestSchema, toCfm50, toRpcTest, ventilationWords, type SavedTest } from './index';

const PROGRAM = parseBlowerDoorSettings(SEEDED).settings.programs[0]!;
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

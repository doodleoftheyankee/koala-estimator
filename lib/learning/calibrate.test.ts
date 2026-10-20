import { describe, expect, it } from 'vitest';
import { ACCESS_LEVELS, type AccessLevel, type CoeffKind, type JobType, type ProductCode } from '@/lib/pricing';
import { calibrate } from './calibrate';
import { predictHours, toCoefficientSet } from './predict';
import { DEFAULT_LEARNING_SETTINGS } from './settings';
import type { CalibrationInput, CalibrationResult, Observation, StoredCoefficient } from './types';
import {
  generateJobs,
  seedActive,
  SEED_TRUTH,
  trueRate,
  trueRemovalRate,
  trueWaste,
  type TrueModel,
} from './__fixtures__/synthetic';

const now = new Date('2026-10-20T12:00:00Z');
const LOOSE = { ...DEFAULT_LEARNING_SETTINGS, maxStepPct: 100, shrinkageK: 0.01 };

/** Every coefficient differs from the seeded active set; cellulose in walls differs by job type. */
const TRUTH: TrueModel = {
  ...SEED_TRUTH,
  waste: { ...SEED_TRUTH.waste, cellulose: 1.2, ocsf: 1.15, batts: 1.08 },
  wasteByJobType: { 'cellulose|walls': 1.3 },
  rate: { ...SEED_TRUTH.rate, cellulose: 0.18, ocsf: 0.0045, batts: 0.018 },
  rateByJobType: { 'cellulose|walls': 0.22 },
  setup: { ...SEED_TRUTH.setup, cellulose: 2.6, ocsf: 3.5, batts: 1.2 },
  access: { easy: 1, moderate: 1.25, difficult: 1.5, extreme: 1.8 },
  removalRate: 0.028,
  removalRateByJobType: { attic: 0.024, crawlspace: 0.033 },
  driveFactor: 1.25,
};
/** Most jobs are easy or moderate, as in the field. */
const LEVELS: AccessLevel[] = ['easy', 'easy', 'easy', 'moderate', 'moderate', 'difficult', 'extreme'];
const PRODUCTS: ProductCode[] = ['cellulose', 'ocsf', 'batts'];
const JOB_TYPES: JobType[] = ['attic', 'walls', 'crawlspace'];
const SIZES: Record<string, number[]> = { cellulose: [20, 60, 150], ocsf: [1000, 3000, 8000], batts: [300, 1000, 2500] };

const clean = generateJobs({ seed: 1, jobs: 600, now, truth: TRUTH, accessLevels: LEVELS });

const run = (o: Partial<CalibrationInput> = {}): CalibrationResult =>
  calibrate({ observations: [], drive: [], active: seedActive(), settings: DEFAULT_LEARNING_SETTINGS, now, ...o });

const find = <T extends StoredCoefficient>(
  cs: readonly T[],
  kind: CoeffKind,
  product: ProductCode | null = null,
  jobType: JobType | null = null,
  accessLevel: AccessLevel | null = null,
): T | undefined => cs.find((c) => c.kind === kind && c.product === product && c.jobType === jobType && c.accessLevel === accessLevel);

const value = (...args: Parameters<typeof find>): number => {
  const c = find(...args);
  if (!c) throw new Error(`missing ${args.slice(1).join('/')}`);
  return c.value;
};

const asActive = (cs: readonly StoredCoefficient[]): StoredCoefficient[] =>
  cs.map((c) => ({
    kind: c.kind,
    product: c.product,
    jobType: c.jobType,
    accessLevel: c.accessLevel,
    value: c.value,
    priorValue: c.priorValue,
    lowerBound: c.lowerBound,
    upperBound: c.upperBound,
    sampleSize: c.sampleSize,
    nEff: c.nEff,
    confidence: c.confidence,
  }));

const rel = (a: number, b: number) => Math.abs(a / b - 1);
const gate = (r: CalibrationResult, name: string) => r.gates.find((g) => g.name === name)!;

const obs = (o: Partial<Observation> = {}): Observation => ({
  jobId: 'j1',
  areaId: 'a1',
  completedAt: '2026-10-01T12:00:00Z',
  product: 'cellulose',
  jobType: 'attic',
  accessLevel: 'easy',
  sqft: 1000,
  designQty: 50,
  modelQty: null,
  estQty: null,
  modelHours: null,
  estHours: null,
  actualQty: null,
  actualHours: null,
  ...o,
});

/** Largest relative error of predicted hours against the true process on realistic job sizes. */
function worstHoursError(active: readonly StoredCoefficient[]): number {
  const set = toCoefficientSet(active);
  let worst = 0;
  for (const product of PRODUCTS)
    for (const jobType of JOB_TYPES)
      for (const accessLevel of ACCESS_LEVELS)
        for (const designQty of SIZES[product]!) {
          const truth = TRUTH.setup[product]! + designQty * trueRate(TRUTH, product, jobType) * TRUTH.access[accessLevel];
          worst = Math.max(worst, rel(predictHours(set, obs({ product, jobType, accessLevel, designQty }))!, truth));
        }
  return worst;
}

describe('calibrate: no data', () => {
  it('copies every coefficient unchanged and cannot auto-promote', () => {
    const active = [...seedActive(), { ...seedActive()[0]!, kind: 'photo_area_bias' as const, product: null, jobType: 'attic' as const }];
    const r = run({ active, settings: { ...DEFAULT_LEARNING_SETTINGS, autoPromote: true } });
    expect(asActive(r.coefficients)).toEqual(active);
    expect(r.coefficients.every((c) => !c.changed && !c.wasClamped && !c.wasStepLimited && c.stdError === null)).toBe(true);
    expect(r.changedCount).toBe(0);
    expect(r.passed).toBe(true);
    expect(r.autoPromotable).toBe(false);
    expect(r.gates.map((g) => g.name)).toEqual(['sanity', 'bounds', 'step_limit', 'min_evidence', 'backtest']);
    expect(gate(r, 'backtest').detail).toMatch(/Insufficient data/);
    expect(r.metrics).toEqual({ nObservations: 0, nUsed: 0, holdout: null });
    expect(find(r.coefficients, 'access_mult', null, null, 'easy')).toMatchObject({ note: expect.stringMatching(/anchor/) });
    expect(find(r.coefficients, 'photo_area_bias', null, 'attic')).toMatchObject({ note: expect.stringMatching(/not calibrated/) });
    expect(find(r.coefficients, 'drive_time_factor')).toMatchObject({ note: expect.stringMatching(/no usable observations/) });
  });

  it('ignores rows that cannot be dated or are not physical', () => {
    const r = run({
      observations: [
        obs({ completedAt: 'yesterday', actualQty: 60, actualHours: 10 }),
        obs({ actualQty: null, actualHours: null }),
        obs({ actualQty: -5, actualHours: Number.NaN }),
        obs({ designQty: 1e12, actualQty: 5 }),
        obs({ product: 'removal', designQty: null, sqft: 0, actualHours: 4 }),
      ],
      drive: [
        { jobId: 'j1', completedAt: 'soon', estMinutes: 20, actualMinutes: 30 },
        { jobId: 'j2', completedAt: '2026-10-01T12:00:00Z', estMinutes: 0, actualMinutes: 30 },
      ],
    });
    expect(r.metrics).toMatchObject({ nObservations: 5, nUsed: 0 });
    expect(r.changedCount).toBe(0);
  });

  it('rejects an invalid clock', () => {
    expect(() => run({ now: new Date('not a date') })).toThrow(RangeError);
  });

  it('repairs nonsensical settings instead of producing NaN', () => {
    const nan = Number.NaN;
    const bad = { ...DEFAULT_LEARNING_SETTINGS, halfLifeDays: nan, shrinkageK: nan, minNEff: nan, maxStepPct: nan, holdoutFrac: nan, winsorPct: nan };
    expect(run({ ...clean, settings: bad })).toEqual(run({ ...clean }));
  });
});

describe('calibrate: recovery of known coefficients', () => {
  it('recovers the truth in one run when the step limit is loose and shrinkage is light', () => {
    const r = run({ ...clean, settings: LOOSE });
    const cs = r.coefficients;
    for (const p of PRODUCTS)
      for (const jt of JOB_TYPES) expect(rel(value(cs, 'waste_factor', p, jt), trueWaste(TRUTH, p, jt))).toBeLessThan(0.02);
    expect(rel(value(cs, 'drive_time_factor'), TRUTH.driveFactor)).toBeLessThan(0.01);
    for (const a of ['moderate', 'difficult', 'extreme'] as const)
      expect(rel(value(cs, 'access_mult', null, null, a), TRUTH.access[a])).toBeLessThan(0.05);
    for (const jt of JOB_TYPES)
      expect(rel(value(cs, 'removal_hrs_per_sqft', null, jt), trueRemovalRate(TRUTH, jt))).toBeLessThan(0.05);
    expect(worstHoursError(cs)).toBeLessThan(0.07);
    expect(r.passed).toBe(true);
  });

  it('converges over successive nightly runs (each starting from the last candidate)', () => {
    // Three alternating passes per run split hours between rates and access multipliers only
    // partly; every run continues from the previous solution.
    let active = seedActive();
    for (let i = 0; i < 6; i++) active = asActive(run({ ...clean, active, settings: LOOSE }).coefficients);
    for (const a of ['moderate', 'difficult', 'extreme'] as const)
      expect(rel(value(active, 'access_mult', null, null, a), TRUTH.access[a])).toBeLessThan(0.02);
    for (const p of ['ocsf', 'batts'] as const)
      for (const jt of JOB_TYPES) expect(rel(value(active, 'labor_hrs_per_unit', p, jt), trueRate(TRUTH, p, jt))).toBeLessThan(0.03);
    for (const jt of JOB_TYPES)
      expect(rel(value(active, 'labor_hrs_per_unit', 'cellulose', jt), trueRate(TRUTH, 'cellulose', jt))).toBeLessThan(0.06);
    for (const jt of JOB_TYPES)
      expect(rel(value(active, 'removal_hrs_per_sqft', null, jt), trueRemovalRate(TRUTH, jt))).toBeLessThan(0.03);
    expect(rel(value(active, 'setup_hours', 'ocsf'), TRUTH.setup.ocsf!)).toBeLessThan(0.12);
    expect(worstHoursError(active)).toBeLessThan(0.05);
  });

  it('records the evidence behind every changed coefficient', () => {
    const r = run({ ...clean, settings: LOOSE });
    const changed = r.coefficients.filter((c) => c.changed);
    expect(changed.length).toBe(r.changedCount);
    expect(changed.length).toBeGreaterThan(30);
    for (const c of changed) {
      expect(c.sampleSize).toBeGreaterThan(0);
      expect(c.nEff).toBeGreaterThan(3);
      expect(c.nEff).toBeLessThanOrEqual(c.sampleSize + 1e-9);
      expect(c.stdError).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThan(50);
      expect(c.confidence).toBeLessThanOrEqual(100);
      expect(c.note).toMatch(/^(new cell \(was [\d.]+\), )?n_eff [\d.]+, (regression, |mean, )?(given setup [\d.]+, )?raw [\d.e-]+, shrunk [\d.e-]+$/);
    }
    expect(r.metrics.nUsed).toBe(clean.observations.length);
    expect(r.metrics.holdout?.n).toBe(Math.ceil(0.2 * clean.observations.length));
  });
});

describe('calibrate: guardrails', () => {
  it('moves toward the truth by at most the 10% step per run, from the value pricing used', () => {
    const active = seedActive();
    const r = run({ ...clean });
    for (const c of r.coefficients) {
      // A new job-type cell starts from its parent's active value.
      const v0 =
        find(active, c.kind, c.product, c.jobType, c.accessLevel)?.value ??
        value(active, c.kind, c.product, null, c.accessLevel);
      expect(Math.abs(c.value - v0)).toBeLessThanOrEqual(0.1 * v0 * (1 + 1e-12));
      if (c.jobType && !find(active, c.kind, c.product, c.jobType, c.accessLevel)) expect(c.priorValue).toBe(v0);
    }
    const up: Array<Parameters<typeof find>> = [
      [r.coefficients, 'waste_factor', 'ocsf'],
      [r.coefficients, 'waste_factor', 'batts'],
      [r.coefficients, 'waste_factor', 'cellulose'],
      [r.coefficients, 'waste_factor', 'cellulose', 'walls'],
      [r.coefficients, 'labor_hrs_per_unit', 'ocsf'],
      [r.coefficients, 'labor_hrs_per_unit', 'batts'],
      [r.coefficients, 'labor_hrs_per_unit', 'cellulose', 'walls'],
      [r.coefficients, 'setup_hours', 'ocsf'],
      [r.coefficients, 'setup_hours', 'cellulose'],
      [r.coefficients, 'access_mult', null, null, 'moderate'],
      [r.coefficients, 'access_mult', null, null, 'difficult'],
      [r.coefficients, 'access_mult', null, null, 'extreme'],
      [r.coefficients, 'removal_hrs_per_sqft'],
      [r.coefficients, 'removal_hrs_per_sqft', null, 'attic'],
      [r.coefficients, 'removal_hrs_per_sqft', null, 'crawlspace'],
      [r.coefficients, 'drive_time_factor'],
    ];
    // Every truth above is higher than the seed. (Batts setup is left out: batts hours are
    // almost all area-driven, so one run cannot pin the intercept; only its step is asserted.)
    for (const args of up) {
      const c = find(...args)!;
      expect(c.value, `${args.slice(1).join('/')}`).toBeGreaterThan(c.priorValue);
    }
    const limited = find(r.coefficients, 'waste_factor', 'cellulose')!;
    expect(limited).toMatchObject({ value: 1.08 * 1.1, wasStepLimited: true, changed: true });
    expect(limited.note).toMatch(/step-limited to 1\.188$/);
    expect(gate(r, 'step_limit').detail).toMatch(/^\d+ limited to ±10% of the active value: .*waste_factor\(cellulose\/\*\/\*\)/);
    expect(r.passed).toBe(true);
    expect(r.autoPromotable).toBe(false); // auto_promote is off by default
    expect(run({ ...clean, settings: { ...DEFAULT_LEARNING_SETTINGS, autoPromote: true } }).autoPromotable).toBe(true);
  });

  it('holds thin cells and creates job-type cells only with enough evidence', () => {
    const rich = generateJobs({ seed: 2, jobs: 30, now, truth: TRUTH, products: ['cellulose'], jobTypes: ['attic'], removalShare: 0 });
    const thin = (prefix: string, product: ProductCode, jobType: JobType, removalShare = 0) =>
      generateJobs({ seed: 3, jobs: 2, now, truth: TRUTH, products: [product], jobTypes: [jobType], maxAreasPerJob: 1, removalShare, idPrefix: prefix });
    const garage = thin('g', 'cellulose', 'garage');
    const batts = thin('b', 'batts', 'walls', 1);
    const r = run({ observations: [...rich.observations, ...garage.observations, ...batts.observations] });
    const cs = r.coefficients;

    const attic = find(cs, 'waste_factor', 'cellulose', 'attic')!;
    expect(attic).toMatchObject({ changed: true, priorValue: 1.08, lowerBound: 1, upperBound: 1.6 });
    expect(attic.note).toMatch(/^new cell \(was 1\.08\)/);
    expect(find(cs, 'labor_hrs_per_unit', 'cellulose', 'attic')).toBeDefined();
    expect(find(cs, 'waste_factor', 'cellulose', 'garage')).toBeUndefined();
    expect(find(cs, 'labor_hrs_per_unit', 'cellulose', 'garage')).toBeUndefined();

    const battsWaste = find(cs, 'waste_factor', 'batts')!;
    expect(battsWaste).toMatchObject({ value: 1.05, changed: false });
    expect(battsWaste.note).toMatch(/^held: n_eff [\d.]+, raw [\d.]+; needs n_eff ≥ 3$/);
    expect(cs.some((c) => c.product === 'batts' && c.jobType !== null)).toBe(false);
    // Removal: 2 rows. The existing walls-free tree stays put.
    expect(find(cs, 'removal_hrs_per_sqft')).toMatchObject({ value: 0.025, changed: false });
    expect(find(cs, 'removal_hrs_per_sqft', null, 'walls')).toBeUndefined();

    expect(gate(r, 'min_evidence').detail).toMatch(/^\d+ held below n_eff 3: .*waste_factor\(batts\/\*\/\*\).*; [1-9]\d* new cell\(s\) not created\.$/);
    expect(gate(r, 'min_evidence').passed).toBe(true);
  });

  it('clamps to the hard bounds', () => {
    const wild: TrueModel = { ...TRUTH, waste: { ...TRUTH.waste, cellulose: 1.9 }, wasteByJobType: {} };
    const data = generateJobs({ seed: 4, jobs: 200, now, truth: wild, products: ['cellulose'] });
    const loose = run({ ...data, settings: LOOSE });
    expect(find(loose.coefficients, 'waste_factor', 'cellulose')).toMatchObject({ value: 1.6, wasClamped: true, wasStepLimited: false });
    expect(find(loose.coefficients, 'waste_factor', 'cellulose')!.note).toMatch(/, clamped to 1\.6$/);
    expect(gate(loose, 'bounds').detail).toMatch(/^[1-9]\d* clamped to bounds: .*waste_factor\(cellulose\/\*\/\*\)/);
    expect(gate(loose, 'bounds').passed).toBe(true);

    // Near the bound, the step limit applies first and the bound still wins.
    const active = seedActive().map((c) => (c.kind === 'waste_factor' && c.product === 'cellulose' ? { ...c, value: 1.55 } : c));
    const near = run({ ...data, active });
    expect(find(near.coefficients, 'waste_factor', 'cellulose')).toMatchObject({ value: 1.6, wasClamped: true, wasStepLimited: true });
    expect(find(near.coefficients, 'waste_factor', 'cellulose')!.note).toMatch(/step-limited, clamped to 1\.6$/);
  });

  it('fails the backtest when an older batch of actuals is corrupted', () => {
    // The active set is the truth. Old jobs had their hours keyed in triple; recent jobs are clean.
    const old = generateJobs({ seed: 5, jobs: 300, now, truth: SEED_TRUTH, minDaysAgo: 200, maxDaysAgo: 500, hoursFactor: 3, idPrefix: 'old' });
    const recent = generateJobs({ seed: 6, jobs: 120, now, truth: SEED_TRUTH, maxDaysAgo: 40, idPrefix: 'new' });
    const r = run({
      observations: [...old.observations, ...recent.observations],
      drive: [...old.drive, ...recent.drive],
      settings: { ...DEFAULT_LEARNING_SETTINGS, autoPromote: true },
    });
    const bt = gate(r, 'backtest');
    expect(bt.passed).toBe(false);
    expect(bt.detail).toMatch(/^Candidate is worse on hours/);
    expect(r.metrics.holdout!.hoursMapeCandidate!).toBeGreaterThan(r.metrics.holdout!.hoursMapeActive!);
    expect(r.passed).toBe(false);
    expect(r.autoPromotable).toBe(false);
    // Hours coefficients were pushed up by the bad batch, but never more than one step.
    expect(find(r.coefficients, 'labor_hrs_per_unit', 'cellulose')).toMatchObject({ value: 0.15 * 1.1, wasStepLimited: true });
  });

  it('passes an insufficient holdout without allowing auto-promotion', () => {
    const settings = { ...DEFAULT_LEARNING_SETTINGS, autoPromote: true };
    const few = generateJobs({ seed: 7, jobs: 3, now, truth: TRUTH, maxAreasPerJob: 1, removalShare: 0 });
    const small = run({ ...few, settings });
    expect(small.metrics.holdout).toBeNull();
    expect(small).toMatchObject({ passed: true, autoPromotable: false });

    // Enough rows for a holdout, but the newest rows have no actuals to score.
    const dated = generateJobs({ seed: 8, jobs: 40, now, truth: TRUTH, minDaysAgo: 30, maxDaysAgo: 300 });
    const pending = Array.from({ length: 30 }, (_, i) => obs({ jobId: `p${i}`, completedAt: '2026-10-19T12:00:00Z' }));
    const thin = run({ ...dated, observations: [...dated.observations, ...pending], settings });
    expect(thin.metrics.holdout).toMatchObject({ hoursMapeActive: null, qtyMapeActive: null });
    expect(gate(thin, 'backtest')).toMatchObject({ passed: true, detail: expect.stringMatching(/^Insufficient holdout/) });
    expect(thin.autoPromotable).toBe(false);
  });

  it('fails the sanity gate for an invalid active value and for an invalid estimate', () => {
    const corrupt = seedActive().map((c) => (c.kind === 'drive_time_factor' ? { ...c, value: 5 } : c));
    const r1 = run({ active: corrupt });
    expect(gate(r1, 'sanity')).toMatchObject({ passed: false, detail: expect.stringMatching(/drive_time_factor\(\*\/\*\/\*\) = 5/) });
    expect(r1.passed).toBe(false);

    // A bound at -1, a 500% step and no shrinkage let a negative estimate through to the end.
    const loose = seedActive().map((c) => (c.kind === 'removal_hrs_per_sqft' && c.jobType === null ? { ...c, lowerBound: -1 } : c));
    const removal = Array.from({ length: 10 }, (_, i) =>
      obs({ jobId: `r${i}`, product: 'removal', designQty: null, jobType: i < 5 ? 'attic' : 'walls', sqft: 1000 + i, actualHours: 0.5 }),
    );
    const r2 = run({ observations: removal, active: loose, settings: { ...DEFAULT_LEARNING_SETTINGS, minNEff: 2, maxStepPct: 5, shrinkageK: 0 } });
    expect(find(r2.coefficients, 'removal_hrs_per_sqft')).toMatchObject({ value: 0.025, changed: false, note: expect.stringMatching(/not a valid coefficient/) });
    // The attic cell has its own bounds and is merely clamped; a walls cell would inherit -1 and is not created.
    expect(find(r2.coefficients, 'removal_hrs_per_sqft', null, 'attic')).toMatchObject({ value: 0.005, wasClamped: true });
    expect(find(r2.coefficients, 'removal_hrs_per_sqft', null, 'walls')).toBeUndefined();
    const sanity = gate(r2, 'sanity');
    expect(sanity.passed).toBe(false);
    expect(sanity.detail).toMatch(/removal_hrs_per_sqft\(\*\/\*\/\*\) estimate -/);
    expect(sanity.detail).toMatch(/removal_hrs_per_sqft\(\*\/walls\/\*\) estimate -/);
  });
});

describe('calibrate: partial active sets', () => {
  it('fits nothing that has no active cell to update, and no hours without access multipliers', () => {
    const active = seedActive().filter((c) => !['removal_hrs_per_sqft', 'drive_time_factor', 'access_mult'].includes(c.kind));
    const r = run({ ...clean, active, settings: LOOSE });
    expect(r.coefficients.some((c) => ['removal_hrs_per_sqft', 'drive_time_factor', 'access_mult'].includes(c.kind))).toBe(false);
    // The engine cannot price hours without an access multiplier, so hours are not learned either.
    for (const c of r.coefficients.filter((c) => c.kind === 'labor_hrs_per_unit' || c.kind === 'setup_hours')) expect(c.changed).toBe(false);
    expect(find(r.coefficients, 'waste_factor', 'cellulose', 'walls')).toBeDefined();
    expect(r.metrics.nUsed).toBe(clean.observations.filter((o) => o.product !== 'removal').length);
  });

  it('skips ratios that overflow on a corrupt active multiplier', () => {
    const active = seedActive().map((c) => (c.kind === 'access_mult' && c.accessLevel === 'extreme' ? { ...c, value: 1e-312 } : c));
    const rows = Array.from({ length: 8 }, (_, i) =>
      obs({ jobId: `r${i}`, product: 'removal', designQty: null, accessLevel: 'extreme', sqft: 900 + i, actualHours: 30 }),
    );
    const r = run({ observations: rows, active, settings: LOOSE });
    expect(r.metrics.nUsed).toBe(0);
    expect(find(r.coefficients, 'removal_hrs_per_sqft')).toMatchObject({ value: 0.025, changed: false });
  });

  it('uses no removal setup when the active set has none', () => {
    const active = seedActive().filter((c) => !(c.kind === 'setup_hours' && c.product === 'removal'));
    const rows = Array.from({ length: 20 }, (_, i) =>
      obs({ jobId: `r${i}`, product: 'removal', designQty: null, sqft: 400 + 50 * i, actualHours: 0.022 * (400 + 50 * i) }),
    );
    const r = run({ observations: rows, active, settings: LOOSE });
    expect(value(r.coefficients, 'removal_hrs_per_sqft', null, 'attic')).toBeCloseTo(0.022, 4);
  });
});

describe('calibrate: hours model edge cases', () => {
  const settings = LOOSE;

  it('keeps setup when job sizes do not vary, and fits the rate by the mean', () => {
    const rows = Array.from({ length: 12 }, (_, i) => obs({ jobId: `s${i}`, designQty: 40, actualHours: 2 + 40 * 0.2 * (1 + (i % 3) / 100) }));
    const r = run({ observations: rows, settings });
    expect(find(r.coefficients, 'setup_hours', 'cellulose')).toMatchObject({ value: 2, changed: false, note: expect.stringMatching(/setup needs 3\+ job sizes/) });
    const rate = find(r.coefficients, 'labor_hrs_per_unit', 'cellulose')!;
    expect(rate.note).toContain(', mean,');
    expect(rate.value).toBeCloseTo(0.2 * 1.01, 3);
  });

  it('keeps setup when the regression gives a negative intercept', () => {
    const rows = Array.from({ length: 20 }, (_, i) => obs({ jobId: `n${i}`, designQty: 20 + 5 * i, actualHours: 0.25 * (20 + 5 * i) - 4 }));
    const r = run({ observations: rows, settings });
    expect(find(r.coefficients, 'setup_hours', 'cellulose')).toMatchObject({ value: 2, note: expect.stringMatching(/setup regression gave -[\d.]+ < 0/) });
    expect(find(r.coefficients, 'labor_hrs_per_unit', 'cellulose')!.note).toContain(', mean,');
  });

  it('fits only the rate for a product without its own setup cell', () => {
    const active = seedActive().filter((c) => !(c.kind === 'setup_hours' && c.product === 'ocsf'));
    const data = generateJobs({ seed: 9, jobs: 60, now, truth: { ...TRUTH, setup: { ...TRUTH.setup, ocsf: 0 } }, products: ['ocsf'], removalShare: 0 });
    const r = run({ ...data, active, settings });
    expect(find(r.coefficients, 'setup_hours', 'ocsf')).toBeUndefined();
    const rate = find(r.coefficients, 'labor_hrs_per_unit', 'ocsf')!;
    expect(rate.note).toContain(', mean,');
    expect(rel(rate.value, 0.0045 * 1.08)).toBeLessThan(0.1); // access split still settling
  });

  it('stays valid when hours are below the setup (rates go negative mid-fit)', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      obs({ jobId: `w${i}`, designQty: 10 + 7 * i, accessLevel: i % 2 ? 'moderate' : 'easy', actualHours: 0.1 + (i % 4) / 100, actualQty: 60 }),
    );
    const r = run({ observations: rows, settings });
    expect(gate(r, 'sanity').passed).toBe(true);
    for (const c of r.coefficients) {
      expect(c.value).toBeGreaterThanOrEqual(c.lowerBound);
      expect(c.value).toBeLessThanOrEqual(c.upperBound);
    }
    expect(find(r.coefficients, 'labor_hrs_per_unit', 'cellulose')).toMatchObject({ value: 0.02, wasClamped: true });
  });

  it('holds everything when every weight has decayed to nothing', () => {
    const ancient = Array.from({ length: 12 }, (_, i) =>
      obs({ jobId: `x${i}`, completedAt: '2010-01-01T00:00:00Z', designQty: 20 + 10 * i, actualHours: 3 + 0.2 * (20 + 10 * i), actualQty: 30 + 11 * i }),
    );
    const r = run({ observations: ancient, settings: { ...LOOSE, halfLifeDays: 1, minNEff: 0 } });
    expect(r.changedCount).toBe(0);
    expect(find(r.coefficients, 'setup_hours', 'cellulose')!.note).toMatch(/setup regression undefined/);
    expect(find(r.coefficients, 'labor_hrs_per_unit', 'cellulose')!.note).toMatch(/^held: n_eff 0/);
  });
});

describe('calibrate: determinism', () => {
  it('returns deep-equal output for the same input, whatever the row order, without mutating it', () => {
    const input: CalibrationInput = { ...clean, active: seedActive(), settings: DEFAULT_LEARNING_SETTINGS, now };
    const before = structuredClone(input);
    const a = calibrate(input);
    expect(calibrate(input)).toEqual(a);
    expect(input).toEqual(before);
    const reversed = { ...input, observations: [...input.observations].reverse(), drive: [...input.drive].reverse() };
    expect(calibrate(reversed)).toEqual(a);
  });

  it('copies a duplicated scope after the first one', () => {
    const active = [...seedActive(), { ...find(seedActive(), 'drive_time_factor')!, value: 1.2 }];
    const r = run({ ...clean, active, settings: LOOSE });
    const drives = r.coefficients.filter((c) => c.kind === 'drive_time_factor');
    expect(drives).toHaveLength(2);
    expect(drives[0]!.changed).toBe(true);
    expect(drives[1]).toMatchObject({ value: 1.2, changed: false });
  });
});

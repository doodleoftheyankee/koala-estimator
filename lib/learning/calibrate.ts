// Coefficient calibration (PLAN.md §6.2-6.4): completed-job actuals in, a candidate coefficient
// set out, every value behind the guardrails. Pure and deterministic: no clock (callers pass
// `now`), no randomness, observations sorted before any floating-point sum.
import { ACCESS_LEVELS, JOB_TYPES, PRODUCTS, type AccessLevel, type CoeffKind, type JobType, type ProductCode } from '@/lib/pricing';
import { backtestGate, evaluateHoldout, holdoutSplit, sortDrive, sortObservations } from './backtest';
import { confidenceScore, standardError } from './confidence';
import { applyGuardrails, isSaneValue } from './guardrails';
import { findStored, toCoefficientSet, usableAmount as usable } from './predict';
import { winsorize } from './robust';
import { normalizeLearningSettings } from './settings';
import { shrink } from './shrinkage';
import type {
  CalibrationInput,
  CalibrationResult,
  CandidateCoefficient,
  DriveObservation,
  GateResult,
  LearningSettings,
  Observation,
  StoredCoefficient,
} from './types';
import { ageDays, effectiveSampleSize, recencyWeight, weightedMean } from './weights';
import { distinctCount, wlsSolve } from './wls';

/** Alternating passes for the hours model: setup and rates given access, then access given rates. */
// Alternating passes between (setup, rate) and access multipliers. 25 converges in a single run
// on realistic data (3 left the rate/access split 4-7% off until several nights later).
const ALS_ITERATIONS = 25;
/**
 * Change detection. Values are stored to 6 decimals (numeric(14,6)), and a move smaller than
 * CHANGE_REL of the active value is noise, not news: either way the active value is kept
 * exactly, so a re-run on the same data changes nothing. The comparison is always with the
 * stored active value, so a slow drift still moves once it adds up past the threshold.
 */
const STORAGE_DP = 6;
const CHANGE_REL = 1e-3;

const CALIBRATED: ReadonlySet<CoeffKind> = new Set<CoeffKind>([
  'waste_factor',
  'labor_hrs_per_unit',
  'access_mult',
  'setup_hours',
  'removal_hrs_per_sqft',
  'drive_time_factor',
]);

/**
 * Recomputes coefficients from completed-job observations (PLAN.md §6.3) and runs every
 * guardrail (§6.4). Pure and deterministic for a given input (including `now`).
 */
export function calibrate(input: CalibrationInput): CalibrationResult {
  if (!Number.isFinite(input.now.getTime())) throw new RangeError('calibrate: `now` is not a valid date');
  const s = normalizeLearningSettings(input.settings);
  const datable = (completedAt: string) => Number.isFinite(Date.parse(completedAt));
  const observations = sortObservations(input.observations.filter((o) => datable(o.completedAt)));
  const drive = sortDrive(input.drive.filter((d) => datable(d.completedAt)));

  const run = (obs: readonly Observation[], drv: readonly DriveObservation[]) => {
    const weigh = <T extends { completedAt: string }>(rows: readonly T[]): Weighted<T>[] =>
      rows.map((o) => ({ o, w: recencyWeight(ageDays(o.completedAt, input.now), s.halfLifeDays) }));
    const weighted = weigh(obs);
    const fit = fitAll(weighted, weigh(drv), input.active, s);
    // Setup and access multipliers enter every rate. Guard them first, then fit the rates
    // holding the guarded values fixed: a setup limited to one step must never be stored next
    // to a rate that assumes the full move, or the pair predicts worse than the active set.
    fitRates(fit, weighted, buildCandidate(input.active, fit.estimates, s).coefficients);
    return { built: buildCandidate(input.active, fit.estimates, s), used: fit.used.size };
  };

  const full = run(observations, drive);

  // Backtest: a candidate fitted on the older part must predict the newest jobs no worse.
  const split = holdoutSplit(observations, s.holdoutFrac);
  const evaluation = split
    ? evaluateHoldout(
        split.holdout,
        toCoefficientSet(input.active, 'active'),
        toCoefficientSet(run(split.train, []).built.coefficients, 'train'),
      )
    : null;
  const backtest = backtestGate(evaluation, observations.length);

  const gates = guardrailGates(full.built, s, backtest.gate);
  const passed = gates.every((g) => g.passed);
  return {
    coefficients: full.built.coefficients,
    changedCount: full.built.coefficients.filter((c) => c.changed).length,
    gates,
    passed,
    autoPromotable: passed && s.autoPromote && backtest.sufficient,
    metrics: {
      nObservations: input.observations.length,
      nUsed: full.used,
      holdout: evaluation?.metrics ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Cells and estimates
// ---------------------------------------------------------------------------

interface Cell {
  kind: CoeffKind;
  product: ProductCode | null;
  jobType: JobType | null;
  accessLevel: AccessLevel | null;
}

const cell = (
  kind: CoeffKind,
  product: ProductCode | null = null,
  jobType: JobType | null = null,
  accessLevel: AccessLevel | null = null,
): Cell => ({ kind, product, jobType, accessLevel });

const cellKey = (c: Cell) => `${c.kind}|${c.product ?? '*'}|${c.jobType ?? '*'}|${c.accessLevel ?? '*'}`;
const label = (c: Cell) => `${c.kind}(${[c.product, c.jobType, c.accessLevel].map((x) => x ?? '*').join('/')})`;

/** A multiplier the hours model can use: finite and positive. */
const priced = (v: number) => Number.isFinite(v) && v > 0;

/**
 * What a top-level cell (no parent cell above it) shrinks toward: its prior, a fixed anchor.
 * Shrinking toward the active value instead lets every promoted run move the anchor, so re-runs
 * on the same data ratchet a thin cell all the way to its raw mean. The active value stands in
 * for a prior that is not a usable coefficient.
 */
const anchor = (c: StoredCoefficient): number => (priced(c.priorValue) ? c.priorValue : c.value);

/** What the data say about one coefficient, before guardrails. */
interface Estimate {
  cell: Cell;
  raw: number | null; // the data's own estimate: weighted mean or regression intercept
  value: number | null; // shrunk toward the parent's estimate (top-level cells: the prior); null without data
  n: number;
  nEff: number;
  stdError: number | null;
  method: string | null; // hours model: 'regression' or 'mean' for the setup, and the setup a rate is fitted at
  hold: string | null; // product setup only: why these data cannot separate it from the rate
  parent: StoredCoefficient | null; // job-type cells: the active parent (bounds and prior of a new cell)
}

interface Weighted<T> {
  o: T;
  w: number;
}

interface Summary {
  mean: number | null;
  n: number;
  nEff: number;
  se: number | null;
}

/** Weighted mean, n_eff and SE of one fitting group's per-observation values (already winsorized). */
function stats(v: number[], weights: number[]): Summary {
  const nEff = effectiveSampleSize(weights);
  return { mean: weightedMean(v, weights), n: v.length, nEff, se: standardError(v, weights, nEff) };
}

/** Winsorized weighted mean, n_eff and SE of one fitting group's per-observation values. */
function summarize(values: number[], weights: number[], winsorPct: number): Summary {
  return stats(winsorize(values, weights, winsorPct), weights);
}

interface Fit {
  active: readonly StoredCoefficient[];
  byKey: Map<string, StoredCoefficient>;
  s: LearningSettings;
  estimates: Map<string, Estimate>;
  used: Set<Observation>;
}

function put(
  fit: Fit,
  c: Cell,
  sm: Summary,
  value: number,
  extra: { method?: string; hold?: string | null; parent?: StoredCoefficient } = {},
): void {
  fit.estimates.set(cellKey(c), {
    cell: cell(c.kind, c.product, c.jobType, c.accessLevel),
    raw: sm.mean,
    value: sm.mean === null ? null : value,
    n: sm.n,
    nEff: sm.nEff,
    stdError: sm.se,
    method: extra.method ?? null,
    hold: extra.hold ?? null,
    parent: extra.parent ?? null,
  });
}

/**
 * First pass: waste, drive, and the hours model's setup and access multipliers. The rates come
 * second (fitRates), once the setup and multipliers they are priced with have been guarded.
 */
function fitAll(
  obs: Weighted<Observation>[],
  drive: Weighted<DriveObservation>[],
  active: readonly StoredCoefficient[],
  s: LearningSettings,
): Fit {
  const byKey = new Map<string, StoredCoefficient>();
  for (const c of active) if (!byKey.has(cellKey(c))) byKey.set(cellKey(c), c);
  const fit: Fit = { active, byKey, s, estimates: new Map(), used: new Set() };
  fitWaste(fit, obs);
  fitHours(fit, obs);
  fitDrive(fit, drive);
  return fit;
}

/**
 * Second pass: labor and removal rates given the guarded setup and access multipliers of the
 * candidate (`coupled`), the values pricing will use alongside them.
 */
function fitRates(fit: Fit, obs: Weighted<Observation>[], coupled: readonly StoredCoefficient[]): void {
  const access = accessValues(coupled);
  fitLaborRates(fit, obs, coupled, access);
  fitRemoval(fit, obs, coupled, access);
}

/** The access multiplier the engine would use for each level (NaN where none is stored). */
function accessValues(coeffs: readonly StoredCoefficient[]): Record<AccessLevel, number> {
  const lookup = (accessLevel: AccessLevel) => findStored(coeffs, 'access_mult', { accessLevel })?.value ?? Number.NaN;
  return { easy: lookup('easy'), moderate: lookup('moderate'), difficult: lookup('difficult'), extreme: lookup('extreme') };
}

// ---------------------------------------------------------------------------
// Ratio kinds: waste, removal, drive
// ---------------------------------------------------------------------------

interface RatioRow {
  o: Observation;
  w: number;
  r: number;
}

function pushRatio(rows: RatioRow[], o: Observation, w: number, r: number): void {
  if (Number.isFinite(r)) rows.push({ o, w, r });
}

/**
 * The parent cell over all rows, shrunk toward its prior, plus one child per job type, each
 * shrunk toward the parent's estimate.
 */
function fitTwoLevel(fit: Fit, parent: StoredCoefficient, rows: RatioRow[]): void {
  if (rows.length === 0) return;
  const k = fit.s.shrinkageK;
  const top = summarize(rows.map((r) => r.r), rows.map((r) => r.w), fit.s.winsorPct);
  const topValue = shrink(top.mean, top.nEff, anchor(parent), k);
  put(fit, parent, top, topValue);
  for (const jobType of JOB_TYPES) {
    const sub = rows.filter((r) => r.o.jobType === jobType);
    if (sub.length === 0) continue;
    const sm = summarize(sub.map((r) => r.r), sub.map((r) => r.w), fit.s.winsorPct);
    const child = cell(parent.kind, parent.product, jobType, parent.accessLevel);
    put(fit, child, sm, shrink(sm.mean, sm.nEff, topValue, k), { parent });
  }
  for (const r of rows) fit.used.add(r.o);
}

/** waste_factor per (product) and (product, job type): actual material / design quantity. */
function fitWaste(fit: Fit, obs: Weighted<Observation>[]): void {
  for (const product of PRODUCTS) {
    const parent = fit.byKey.get(cellKey(cell('waste_factor', product)));
    if (product === 'removal' || !parent) continue;
    const rows: RatioRow[] = [];
    for (const { o, w } of obs) {
      if (o.product !== product) continue;
      const design = usable(o.designQty);
      const actual = usable(o.actualQty);
      if (design !== null && actual !== null) pushRatio(rows, o, w, actual / design);
    }
    fitTwoLevel(fit, parent, rows);
  }
}

/**
 * removal_hrs_per_sqft per job type and overall: (hours − setup) / (sqft × access), at the
 * candidate's removal setup and access multipliers.
 */
function fitRemoval(
  fit: Fit,
  obs: Weighted<Observation>[],
  coupled: readonly StoredCoefficient[],
  access: Readonly<Record<AccessLevel, number>>,
): void {
  const root = fit.byKey.get(cellKey(cell('removal_hrs_per_sqft')));
  if (!root) return;
  const setup = findStored(coupled, 'setup_hours', { product: 'removal' })?.value ?? 0;
  const rows: RatioRow[] = [];
  for (const { o, w } of obs) {
    const hours = usable(o.actualHours);
    const sqft = usable(o.sqft);
    if (o.product === 'removal' && hours !== null && sqft !== null && priced(access[o.accessLevel]))
      pushRatio(rows, o, w, (hours - setup) / (sqft * access[o.accessLevel]));
  }
  fitTwoLevel(fit, root, rows);
}

/** drive_time_factor (one global cell): actual / estimated one-way minutes. */
function fitDrive(fit: Fit, drive: Weighted<DriveObservation>[]): void {
  const own = fit.byKey.get(cellKey(cell('drive_time_factor')));
  if (!own) return;
  const rows: Array<{ r: number; w: number }> = [];
  for (const { o, w } of drive) {
    const est = usable(o.estMinutes);
    const actual = usable(o.actualMinutes);
    if (est !== null && actual !== null) rows.push({ r: actual / est, w });
  }
  if (rows.length === 0) return;
  const sm = summarize(rows.map((r) => r.r), rows.map((r) => r.w), fit.s.winsorPct);
  put(fit, own, sm, shrink(sm.mean, sm.nEff, anchor(own), fit.s.shrinkageK));
}

// ---------------------------------------------------------------------------
// Hours model: hours = setup(product) + designQty × rate(product, job type) × access(level)
// ---------------------------------------------------------------------------

interface LaborRow {
  o: Observation;
  w: number;
  q: number; // design quantity
  h: number; // actual hours
}

interface HoursRow extends LaborRow {
  setup: number; // working setup of the row's product (NaN until fitted)
  rate: number; // working rate of the row's (product, job type) cell (NaN until fitted)
}

/** A row at its access-adjusted size x = designQty × access. */
interface Sized<R extends LaborRow> {
  r: R;
  x: number;
  w: number;
}

/** One product's rows with a usable design quantity and hours, at a level the engine can price. */
function laborRows(obs: Weighted<Observation>[], product: ProductCode, access: Readonly<Record<AccessLevel, number>>): LaborRow[] {
  const rows: LaborRow[] = [];
  for (const { o, w } of obs) {
    const q = usable(o.designQty);
    const h = usable(o.actualHours);
    if (o.product === product && q !== null && h !== null && priced(access[o.accessLevel])) rows.push({ o, w, q, h });
  }
  return rows;
}

const sized = <R extends LaborRow>(rows: readonly R[], access: Readonly<Record<AccessLevel, number>>): Sized<R>[] =>
  rows.map((r) => ({ r, x: r.q * access[r.o.accessLevel], w: r.w })).filter((p) => priced(p.x));

/**
 * Rates given a setup: each job's (hours − setup) / x, winsorized within its job type (one clip
 * over the pooled jobs would cut into the real gap between job types). One summary per job type
 * present, and the product's pooled summary over the same clipped values.
 */
function rateSummaries<R extends LaborRow>(
  pts: readonly Sized<R>[],
  setup: number,
  winsorPct: number,
  refRate?: (r: R) => number,
): { pooled: Summary; byJobType: Array<{ jobType: JobType; sub: Sized<R>[]; sm: Summary }> } {
  const values: number[] = [];
  const weights: number[] = [];
  const byJobType: Array<{ jobType: JobType; sub: Sized<R>[]; sm: Summary }> = [];
  for (const jobType of JOB_TYPES) {
    const sub = pts.filter((p) => p.r.o.jobType === jobType);
    if (sub.length === 0) continue;
    const MODE = process.env.RW ?? 'A';
    const ws = sub.map((p) => {
      if (MODE === 'B') return p.w * p.x;
      if (MODE === 'C') return p.w * (p.x / p.r.h) ** 2;
      if (MODE === 'D') { const hh = setup + (refRate ? refRate(p.r) : (p.r.h - setup) / p.x) * p.x; return p.w * (p.x / hh) ** 2; }
      return p.w;
    });
    const v = winsorize(sub.map((p) => (p.r.h - setup) / p.x), ws, winsorPct);
    byJobType.push({ jobType, sub, sm: stats(v, ws) });
    values.push(...v);
    weights.push(...ws);
  }
  return { pooled: stats(values, weights), byJobType };
}

/**
 * The setup regression: hours on [1, x · 1{job type = j} for each job type present], one shared
 * intercept (the setup) and one slope per job type. A single pooled line would read the gap
 * between job types that differ in rate and in size (big attics at a low rate, small wall
 * cavities at a high one) as setup. Held without 3+ job sizes and n_eff ≥ 2 · min_n_eff, when
 * no job type's sizes vary (singular), or when the intercept is negative.
 */
function fitSetup(
  pts: ReadonlyArray<{ jobType: JobType; x: number; y: number; w: number }>,
  nEff: number,
  s: LearningSettings,
): { raw: number | null; hold: string | null } {
  if (distinctCount(pts.map((p) => p.x)) < 3 || nEff < 2 * s.minNEff)
    return { raw: null, hold: `setup needs 3+ job sizes and n_eff ≥ ${fmt(2 * s.minNEff)} (have ${fmt(nEff)})` };
  const present = JOB_TYPES.filter((jt) => pts.some((p) => p.jobType === jt && p.w > 0));
  const beta = wlsSolve(pts.map((p) => ({ x: [1, ...present.map((jt) => (p.jobType === jt ? p.x : 0))], y: p.y, w: p.w })));
  if (!beta) return { raw: null, hold: 'setup regression undefined' };
  if (beta[0]! < 0) return { raw: null, hold: `setup regression gave ${fmt(beta[0]!)} < 0` };
  return { raw: beta[0]!, hold: null };
}

interface ProductGroup {
  rateCell: StoredCoefficient; // active product-level rate
  setupCell: StoredCoefficient | null; // null: setup is not stored per product, so it is not fitted
  setup0: number; // active setup (what pricing uses)
  setupAnchor: number; // what a fitted setup is shrunk toward
  setup: number; // working values
  rate: number;
  rows: HoursRow[];
}

/**
 * First pass of the hours model: alternating least squares for setup and the access
 * multipliers, with the 'easy' multiplier held at its active value (otherwise rates and
 * multipliers are only identified up to a common factor). Its working rates are not kept:
 * fitLaborRates refits them at the guarded setup and multipliers.
 */
function fitHours(fit: Fit, obs: Weighted<Observation>[]): void {
  const { s } = fit;
  const k = s.shrinkageK;

  const access = accessValues(fit.active);
  const accessCells: Array<{ level: AccessLevel; own: StoredCoefficient }> = [];
  for (const level of ACCESS_LEVELS) {
    const own = fit.byKey.get(cellKey(cell('access_mult', null, null, level)));
    if (own && level !== 'easy') accessCells.push({ level, own });
  }

  const groups: ProductGroup[] = [];
  for (const product of PRODUCTS) {
    const rateCell = fit.byKey.get(cellKey(cell('labor_hrs_per_unit', product)));
    if (product === 'removal' || !rateCell) continue;
    const setupCell = fit.byKey.get(cellKey(cell('setup_hours', product))) ?? null;
    const setup0 = setupCell?.value ?? findStored(fit.active, 'setup_hours', { product })?.value ?? 0;
    const rows = laborRows(obs, product, access).map((r) => ({ ...r, setup: Number.NaN, rate: Number.NaN }));
    if (rows.length > 0) {
      const setupAnchor = setupCell ? anchor(setupCell) : setup0;
      groups.push({ rateCell, setupCell, setup0, setupAnchor, setup: setup0, rate: rateCell.value, rows });
    }
  }

  for (let iter = 1; iter <= ALS_ITERATIONS; iter++) {
    const last = iter === ALS_ITERATIONS;

    // (i) Given access: setup per product, then the rates per product and job type at that setup.
    for (const g of groups) {
      const pts = sized(g.rows, access);
      const ws = pts.map((p) => p.w);
      const nEff = effectiveSampleSize(ws);
      const rateOf = (r: HoursRow) => (Number.isFinite(r.rate) ? r.rate : g.rate);
      // Each job's ratio actual / predicted hours under the current fit (at its job type's
      // rate), winsorized; the regression sees the winsorized hours, so one mis-keyed job
      // cannot tilt it. The ratio is centred at 1 for small and large jobs and for every job
      // type alike, so clipping does not bias setup.
      const ref = pts.map((p) => g.setup + rateOf(p.r) * p.x);
      const ratios = ref.every(priced) ? winsorize(pts.map((p, i) => p.r.h / ref[i]!), ws, s.winsorPct) : null;
      const adjusted = pts.map((p, i) => ({ jobType: p.r.o.jobType, x: p.x, y: ratios ? ratios[i]! * ref[i]! : p.r.h, w: p.w }));

      // Without a regression the setup stays at its active value.
      const setup = g.setupCell ? fitSetup(adjusted, nEff, s) : null;
      const setupRaw = setup?.raw ?? null;
      g.setup = setupRaw === null ? g.setup0 : shrink(setupRaw, nEff, g.setupAnchor, k);

      const { pooled, byJobType } = rateSummaries(pts, g.setup, s.winsorPct, rateOf);
      g.rate = shrink(pooled.mean, nEff, anchor(g.rateCell), k);
      for (const { sub, sm } of byJobType) {
        const v = shrink(sm.mean, sm.nEff, g.rate, k);
        for (const p of sub) {
          p.r.setup = g.setup;
          p.r.rate = v;
        }
      }

      if (last && g.setupCell && setup) {
        // Each job's implied setup at its job type's rate.
        const setups = adjusted.map((p, i) => p.y - rateOf(pts[i]!.r) * p.x);
        const sm = { mean: setupRaw ?? g.setup0, n: pts.length, nEff, se: standardError(setups, ws, nEff) };
        put(fit, g.setupCell, sm, g.setup, { method: setupRaw === null ? 'mean' : 'regression', hold: setup.hold });
      }
    }

    // (ii) Given setup and rates: each multiplier other than the 'easy' anchor.
    for (const { level, own } of accessCells) {
      const rows: Array<{ r: number; w: number }> = [];
      for (const g of groups) {
        for (const row of g.rows) {
          const den = row.q * row.rate;
          const r = (row.h - row.setup) / den;
          if (row.o.accessLevel === level && den > 0 && Number.isFinite(r)) rows.push({ r, w: row.w });
        }
      }
      if (rows.length === 0) continue;
      const sm = summarize(rows.map((r) => r.r), rows.map((r) => r.w), s.winsorPct);
      const v = shrink(sm.mean, sm.nEff, anchor(own), k);
      // A non-positive working multiplier would poison the next pass; guardrails judge the final value.
      if (priced(v)) access[level] = v;
      if (last) put(fit, own, sm, v);
    }
  }
}

/**
 * labor_hrs_per_unit at the candidate's setup and access multipliers: per product the pooled
 * (hours − setup) / x over every job type, shrunk toward its prior; per (product, job type) its
 * own, shrunk toward the product's estimate.
 */
function fitLaborRates(
  fit: Fit,
  obs: Weighted<Observation>[],
  coupled: readonly StoredCoefficient[],
  access: Readonly<Record<AccessLevel, number>>,
): void {
  const k = fit.s.shrinkageK;
  for (const product of PRODUCTS) {
    const rateCell = fit.byKey.get(cellKey(cell('labor_hrs_per_unit', product)));
    if (product === 'removal' || !rateCell) continue;
    const pts = sized(laborRows(obs, product, access), access);
    if (pts.length === 0) continue;
    const setup = findStored(coupled, 'setup_hours', { product })?.value ?? 0;
    // 'regression' when that setup came out of this run's hours regression, 'mean' when it is held.
    const regressed = fit.estimates.get(cellKey(cell('setup_hours', product)))?.hold === null;
    const given = `given setup ${fmt(setup)}`;
    const { pooled, byJobType } = rateSummaries(pts, setup, fit.s.winsorPct, (r) => findStored(fit.active, 'labor_hrs_per_unit', { product, jobType: r.o.jobType })!.value);
    const value = shrink(pooled.mean, pooled.nEff, anchor(rateCell), k);
    put(fit, rateCell, pooled, value, { method: `${regressed ? 'regression' : 'mean'}, ${given}` });
    for (const { jobType, sm } of byJobType) {
      const child = cell('labor_hrs_per_unit', product, jobType);
      put(fit, child, sm, shrink(sm.mean, sm.nEff, value, k), { method: given, parent: rateCell });
    }
    for (const p of pts) fit.used.add(p.r.o);
  }
}

// ---------------------------------------------------------------------------
// Candidate set and guardrails
// ---------------------------------------------------------------------------

interface Built {
  coefficients: CandidateCoefficient[];
  held: string[]; // min evidence kept the active value
  heldNew: number; // new cells not created for lack of evidence
  limited: string[];
  clamped: string[];
  insane: string[]; // estimates that were not valid coefficients
}

const fmt = (n: number | null): string => (n === null ? 'n/a' : String(Number(n.toPrecision(4))));

/** A value as the coefficients table holds it (rounded like nightlyCore's coefficientRow). */
const atStorage = (n: number): number => Math.round(n * 10 ** STORAGE_DP) / 10 ** STORAGE_DP;

function copy(a: StoredCoefficient, note: string): CandidateCoefficient {
  return {
    kind: a.kind,
    product: a.product,
    jobType: a.jobType,
    accessLevel: a.accessLevel,
    value: a.value,
    priorValue: a.priorValue,
    lowerBound: a.lowerBound,
    upperBound: a.upperBound,
    sampleSize: a.sampleSize,
    nEff: a.nEff,
    confidence: a.confidence,
    stdError: null,
    wasClamped: false,
    wasStepLimited: false,
    changed: false,
    note,
  };
}

function copyNote(a: StoredCoefficient): string {
  if (a.kind === 'access_mult' && a.accessLevel === 'easy' && a.product === null && a.jobType === null)
    return 'unchanged: anchor of the hours model';
  if (!CALIBRATED.has(a.kind)) return 'unchanged: not calibrated from job actuals';
  return 'unchanged: no usable observations for this cell';
}

/**
 * Guardrails for one coefficient. `base` carries scope, prior and bounds; `v0` is the value
 * pricing used until now (for a new cell, its parent's active value). `keep` is false for a new
 * cell that must not be created (too little evidence, or an invalid estimate).
 */
function guarded(
  base: StoredCoefficient,
  v0: number,
  est: Estimate,
  isNew: boolean,
  s: LearningSettings,
  b: Built,
): { c: CandidateCoefficient; keep: boolean } {
  const g = applyGuardrails(
    { active: v0, estimate: est.value, nEff: est.nEff, lowerBound: base.lowerBound, upperBound: base.upperBound },
    s,
  );
  const evidence = `n_eff ${fmt(est.nEff)}${est.method ? `, ${est.method}` : ''}, raw ${fmt(est.raw)}`;
  if (g.held) {
    if (isNew) b.heldNew++;
    else b.held.push(label(base));
    return { c: copy(base, `held: ${evidence}; needs n_eff ≥ ${fmt(s.minNEff)}`), keep: !isNew };
  }
  if (!g.sane) {
    b.insane.push(`${label(base)} estimate ${fmt(est.value)}`);
    return { c: copy(base, `kept active value: estimate ${fmt(est.value)} is not a valid coefficient`), keep: !isNew };
  }
  // A move the table cannot store, or one smaller than CHANGE_REL of the active value, keeps
  // the active value exactly. The band is never wider than half a step, so a tiny max_step_pct
  // still lets values move.
  const band = Math.min(CHANGE_REL, s.maxStepPct / 2);
  const same =
    !isNew &&
    isSaneValue(v0, base.lowerBound, base.upperBound) &&
    (atStorage(g.value) === atStorage(v0) || Math.abs(g.value - v0) < band * v0);
  const value = same ? v0 : g.value;
  const limited = !same && g.wasStepLimited;
  const clamped = !same && g.wasClamped;
  if (limited) b.limited.push(label(base));
  if (clamped) b.clamped.push(label(base));
  const tail = same
    ? `within ${fmt(band * 100)}% of the active value`
    : clamped
      ? `${limited ? 'step-limited, ' : ''}clamped to ${fmt(value)}`
      : limited
        ? `step-limited to ${fmt(value)}`
        : null;
  const note = [isNew ? `new cell (was ${fmt(v0)})` : null, evidence, `shrunk ${fmt(est.value)}`, tail]
    .filter((x): x is string => x !== null)
    .join(', ');
  const c: CandidateCoefficient = {
    kind: base.kind,
    product: base.product,
    jobType: base.jobType,
    accessLevel: base.accessLevel,
    value,
    priorValue: base.priorValue,
    lowerBound: base.lowerBound,
    upperBound: base.upperBound,
    sampleSize: est.n,
    nEff: est.nEff,
    confidence: confidenceScore(est.nEff, value, est.stdError),
    stdError: est.stdError,
    wasClamped: clamped,
    wasStepLimited: limited,
    changed: !same,
    note: same ? `unchanged: ${note}` : note,
  };
  return { c, keep: true };
}

/**
 * Every active coefficient (guarded update or copy, in the active order), then new job-type
 * cells. A new cell inherits its parent's bounds and uses the parent's active value as both
 * prior and step-limit reference, so pricing for that scope moves at most one step per run.
 */
function buildCandidate(
  active: readonly StoredCoefficient[],
  estimates: ReadonlyMap<string, Estimate>,
  s: LearningSettings,
): Built {
  const b: Built = { coefficients: [], held: [], heldNew: 0, limited: [], clamped: [], insane: [] };
  const seen = new Set<string>();
  for (const a of active) {
    const key = cellKey(a);
    const est = seen.has(key) ? undefined : estimates.get(key); // a duplicate scope is copied
    seen.add(key);
    if (!est) b.coefficients.push(copy(a, copyNote(a)));
    else if (est.hold !== null) b.coefficients.push(copy(a, `unchanged: ${est.hold}`));
    else b.coefficients.push(guarded(a, a.value, est, false, s, b).c);
  }
  // Only job-type cells carry a parent, so only they can be new.
  const fresh = [...estimates.values()].filter(
    (e): e is Estimate & { parent: StoredCoefficient } => !seen.has(cellKey(e.cell)) && e.parent !== null,
  );
  for (const est of fresh) {
    const { parent } = est;
    const base: StoredCoefficient = {
      ...est.cell,
      value: parent.value,
      priorValue: parent.value,
      lowerBound: parent.lowerBound,
      upperBound: parent.upperBound,
      sampleSize: 0,
      nEff: 0,
      confidence: 0,
    };
    const { c, keep } = guarded(base, parent.value, est, true, s, b);
    if (keep) b.coefficients.push(c);
  }
  return b;
}

const list = (xs: string[]) => (xs.length ? `: ${xs.join(', ')}` : '');

function guardrailGates(b: Built, s: LearningSettings, backtest: GateResult): GateResult[] {
  const invalid = b.coefficients
    .filter((c) => !isSaneValue(c.value, c.lowerBound, c.upperBound))
    .map((c) => `${label(c)} = ${fmt(c.value)} (bounds ${fmt(c.lowerBound)}-${fmt(c.upperBound)})`);
  const problems = [...b.insane, ...invalid];
  return [
    {
      name: 'sanity',
      passed: problems.length === 0,
      detail:
        problems.length === 0
          ? `All ${b.coefficients.length} coefficients are finite, positive and within bounds.`
          : `${problems.length} problem(s): ${problems.join('; ')}.`,
    },
    { name: 'bounds', passed: true, detail: `${b.clamped.length} clamped to bounds${list(b.clamped)}.` },
    {
      name: 'step_limit',
      passed: true,
      detail: `${b.limited.length} limited to ±${fmt(s.maxStepPct * 100)}% of the active value${list(b.limited)}.`,
    },
    {
      name: 'min_evidence',
      passed: true,
      detail: `${b.held.length} held below n_eff ${fmt(s.minNEff)}${list(b.held)}; ${b.heldNew} new cell(s) not created.`,
    },
    backtest,
  ];
}

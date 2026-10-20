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
import { distinctCount, wlsLine } from './wls';

/** Alternating passes for the hours model: (setup, rates) given access, then access given rates. */
// Alternating passes between (setup, rate) and access multipliers. 25 converges in a single run
// on realistic data (3 left the rate/access split 4-7% off until several nights later).
const ALS_ITERATIONS = 25;
/** Smaller differences are float noise, not a change. */
const CHANGE_EPS = 1e-9;

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
    const fit = fitAll(weigh(obs), weigh(drv), input.active, s);
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

/** What the data say about one coefficient, before guardrails. */
interface Estimate {
  cell: Cell;
  raw: number | null; // the data's own estimate: weighted mean or regression
  value: number | null; // shrunk toward the parent (or the active value); null without data
  n: number;
  nEff: number;
  stdError: number | null;
  method: string | null; // hours model: 'regression' or 'mean'
  hold: string | null; // product setup only: why these data cannot separate it from the rate
  parent: StoredCoefficient | null; // job-type cells: the active cell they are shrunk toward
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

/** Winsorized weighted mean, n_eff and SE of one fitting group's per-observation values. */
function summarize(values: number[], weights: number[], winsorPct: number): Summary {
  const v = winsorize(values, weights, winsorPct);
  const nEff = effectiveSampleSize(weights);
  return { mean: weightedMean(v, weights), n: values.length, nEff, se: standardError(v, weights, nEff) };
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
  const access = fitHours(fit, obs);
  fitRemoval(fit, obs, access);
  fitDrive(fit, drive);
  return fit;
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

/** The parent cell over all rows plus one child per job type, each shrunk toward the level above. */
function fitTwoLevel(fit: Fit, parent: StoredCoefficient, rows: RatioRow[]): void {
  if (rows.length === 0) return;
  const k = fit.s.shrinkageK;
  const top = summarize(rows.map((r) => r.r), rows.map((r) => r.w), fit.s.winsorPct);
  const topValue = shrink(top.mean, top.nEff, parent.value, k);
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

/** removal_hrs_per_sqft per job type and overall: (hours − setup) / (sqft × access). */
function fitRemoval(fit: Fit, obs: Weighted<Observation>[], access: Readonly<Record<AccessLevel, number>>): void {
  const root = fit.byKey.get(cellKey(cell('removal_hrs_per_sqft')));
  if (!root) return;
  const setup = findStored(fit.active, 'setup_hours', { product: 'removal' })?.value ?? 0;
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
  put(fit, own, sm, shrink(sm.mean, sm.nEff, own.value, fit.s.shrinkageK));
}

// ---------------------------------------------------------------------------
// Hours model: hours = setup(product) + designQty × rate(product, job type) × access(level)
// ---------------------------------------------------------------------------

interface HoursRow {
  o: Observation;
  w: number;
  q: number; // design quantity
  h: number; // actual hours
  setup: number; // working setup of the row's product (NaN until fitted)
  rate: number; // working rate of the row's (product, job type) cell (NaN until fitted)
}

interface ProductGroup {
  product: ProductCode;
  rateCell: StoredCoefficient; // active product-level rate
  setupCell: StoredCoefficient | null; // null: setup is not stored per product, so it is not fitted
  setup0: number; // active setup (what pricing uses)
  setup: number; // working values
  rate: number;
  rows: HoursRow[];
}

/** A multiplier the hours model can use: finite and positive. */
const priced = (v: number) => Number.isFinite(v) && v > 0;

/**
 * Alternating least squares with the 'easy' multiplier held at its active value (otherwise
 * rates and multipliers are only identified up to a common factor). Returns the working access
 * multipliers (NaN for a level the active set cannot price), which removal hours reuse.
 */
function fitHours(fit: Fit, obs: Weighted<Observation>[]): Record<AccessLevel, number> {
  const { s } = fit;
  const k = s.shrinkageK;

  const lookup = (accessLevel: AccessLevel) => findStored(fit.active, 'access_mult', { accessLevel })?.value ?? Number.NaN;
  const access: Record<AccessLevel, number> = {
    easy: lookup('easy'),
    moderate: lookup('moderate'),
    difficult: lookup('difficult'),
    extreme: lookup('extreme'),
  };
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
    const rows: HoursRow[] = [];
    for (const { o, w } of obs) {
      const q = usable(o.designQty);
      const h = usable(o.actualHours);
      if (o.product === product && q !== null && h !== null && priced(access[o.accessLevel]))
        rows.push({ o, w, q, h, setup: Number.NaN, rate: Number.NaN });
    }
    if (rows.length > 0) groups.push({ product, rateCell, setupCell, setup0, setup: setup0, rate: rateCell.value, rows });
  }

  for (let iter = 1; iter <= ALS_ITERATIONS; iter++) {
    const last = iter === ALS_ITERATIONS;

    // (i) Given access: setup and rate per product, then a rate per (product, job type).
    for (const g of groups) {
      const pts = g.rows.map((r) => ({ r, x: r.q * access[r.o.accessLevel], w: r.w })).filter((p) => priced(p.x));
      const ws = pts.map((p) => p.w);
      const nEff = effectiveSampleSize(ws);
      // Each job's ratio actual / predicted hours under the current fit, winsorized; the
      // regression sees the winsorized hours, so one mis-keyed job cannot tilt the line. The
      // ratio is centred at 1 for small and large jobs alike, so clipping does not bias setup.
      const ref = pts.map((p) => g.setup + g.rate * p.x);
      const ratios = ref.every(priced) ? winsorize(pts.map((p, i) => p.r.h / ref[i]!), ws, s.winsorPct) : null;
      const adjusted = pts.map((p, i) => ({ x: p.x, y: ratios ? ratios[i]! * ref[i]! : p.r.h, w: p.w }));

      let setupRaw = g.setup0;
      let rateRaw: number | null = null;
      let hold: string | null = null;
      if (g.setupCell) {
        if (distinctCount(pts.map((p) => p.x)) < 3 || nEff < 2 * s.minNEff) {
          hold = `setup needs 3+ job sizes and n_eff ≥ ${fmt(2 * s.minNEff)} (have ${fmt(nEff)})`;
        } else {
          const line = wlsLine(adjusted);
          if (!line) hold = 'setup regression undefined';
          else if (line.intercept < 0) hold = `setup regression gave ${fmt(line.intercept)} < 0`;
          else {
            setupRaw = line.intercept;
            rateRaw = line.slope;
          }
        }
      }
      // Without a regression the setup stays at its active value and the rate is the mean.
      const method = rateRaw === null ? 'mean' : 'regression';
      rateRaw ??= weightedMean(adjusted.map((p) => (p.y - g.setup0) / p.x), ws);
      g.setup = shrink(setupRaw, nEff, g.setup0, k);
      g.rate = shrink(rateRaw, nEff, g.rateCell.value, k);

      if (last) {
        const rates = adjusted.map((p) => (p.y - g.setup) / p.x);
        put(fit, g.rateCell, { mean: rateRaw, n: pts.length, nEff, se: standardError(rates, ws, nEff) }, g.rate, { method });
        if (g.setupCell) {
          const setups = adjusted.map((p) => p.y - g.rate * p.x);
          const sm = { mean: setupRaw, n: pts.length, nEff, se: standardError(setups, ws, nEff) };
          put(fit, g.setupCell, sm, g.setup, { method, hold });
        }
        for (const p of pts) fit.used.add(p.r.o);
      }

      for (const jobType of JOB_TYPES) {
        const sub = pts.filter((p) => p.r.o.jobType === jobType);
        if (sub.length === 0) continue;
        const sm = summarize(sub.map((p) => (p.r.h - g.setup) / p.x), sub.map((p) => p.w), s.winsorPct);
        const v = shrink(sm.mean, sm.nEff, g.rate, k);
        for (const p of sub) {
          p.r.setup = g.setup;
          p.r.rate = v;
        }
        if (last) put(fit, cell('labor_hrs_per_unit', g.product, jobType), sm, v, { parent: g.rateCell });
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
      const v = shrink(sm.mean, sm.nEff, own.value, k);
      // A non-positive working multiplier would poison the next pass; guardrails judge the final value.
      if (priced(v)) access[level] = v;
      if (last) put(fit, own, sm, v);
    }
  }
  return access;
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
  if (g.wasStepLimited) b.limited.push(label(base));
  if (g.wasClamped) b.clamped.push(label(base));
  const tail = g.wasClamped
    ? `${g.wasStepLimited ? 'step-limited, ' : ''}clamped to ${fmt(g.value)}`
    : g.wasStepLimited
      ? `step-limited to ${fmt(g.value)}`
      : null;
  const note = [isNew ? `new cell (was ${fmt(v0)})` : null, evidence, `shrunk ${fmt(est.value)}`, tail]
    .filter((x): x is string => x !== null)
    .join(', ');
  const c: CandidateCoefficient = {
    kind: base.kind,
    product: base.product,
    jobType: base.jobType,
    accessLevel: base.accessLevel,
    value: g.value,
    priorValue: base.priorValue,
    lowerBound: base.lowerBound,
    upperBound: base.upperBound,
    sampleSize: est.n,
    nEff: est.nEff,
    confidence: confidenceScore(est.nEff, g.value, est.stdError),
    stdError: est.stdError,
    wasClamped: g.wasClamped,
    wasStepLimited: g.wasStepLimited,
    changed: isNew || Math.abs(g.value - base.value) > CHANGE_EPS,
    note,
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

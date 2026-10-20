// Backtest gate (PLAN.md §6.4.5): a candidate fitted on older jobs must not predict the most
// recent jobs worse than the active set does. Time-ordered, never shuffled.
import type { CoefficientSet } from '@/lib/pricing';
import { predictHours, predictQty, usableAmount } from './predict';
import type { BacktestMetrics, DriveObservation, GateResult, Observation } from './types';

/** Below this many observations there is no holdout at all. */
export const MIN_BACKTEST_N = 10;
/** A holdout with fewer usable rows passes, but is too thin to auto-promote on. */
export const MIN_HOLDOUT_ROWS = 5;
/**
 * Noise allowance: a refit that is as good as the active set can still score slightly worse on
 * a small holdout by chance. The candidate fails only when it is worse by more than 2% of the
 * active MAPE plus half a percentage point; a corrupted batch misses by far more than that.
 */
const REL_TOLERANCE = 0.02;
const ABS_TOLERANCE = 0.005;
const worseThan = (candidate: number, active: number) => candidate > active * (1 + REL_TOLERANCE) + ABS_TOLERANCE;

const cmp = (a: string | number | null, b: string | number | null) => {
  const x = a ?? Number.NEGATIVE_INFINITY;
  const y = b ?? Number.NEGATIVE_INFINITY;
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Order by (completedAt, jobId, areaId, product); the remaining fields only break ties between
 * duplicate rows, so the order (and every floating-point sum) never depends on the input order.
 * Callers drop rows whose date does not parse.
 */
export function compareObservations(a: Observation, b: Observation): number {
  return (
    cmp(Date.parse(a.completedAt), Date.parse(b.completedAt)) ||
    cmp(a.jobId, b.jobId) ||
    cmp(a.areaId, b.areaId) ||
    cmp(a.product, b.product) ||
    cmp(a.jobType, b.jobType) ||
    cmp(a.accessLevel, b.accessLevel) ||
    cmp(a.sqft, b.sqft) ||
    cmp(a.designQty, b.designQty) ||
    cmp(a.actualQty, b.actualQty) ||
    cmp(a.actualHours, b.actualHours)
  );
}

/** A sorted copy. */
export function sortObservations(obs: readonly Observation[]): Observation[] {
  return [...obs].sort(compareObservations);
}

/** Drive rows in the same spirit: (completedAt, jobId), then the minutes. */
export function sortDrive(drive: readonly DriveObservation[]): DriveObservation[] {
  return [...drive].sort(
    (a, b) =>
      cmp(Date.parse(a.completedAt), Date.parse(b.completedAt)) ||
      cmp(a.jobId, b.jobId) ||
      cmp(a.estMinutes, b.estMinutes) ||
      cmp(a.actualMinutes, b.actualMinutes),
  );
}

/**
 * Splits time-ordered rows: the holdout is the last ceil(frac · n), and at least one row stays
 * on each side. Null below MIN_BACKTEST_N rows.
 */
export function holdoutSplit<T>(sorted: readonly T[], frac: number): { train: T[]; holdout: T[] } | null {
  const n = sorted.length;
  if (n < MIN_BACKTEST_N) return null;
  const k = Math.min(n - 1, Math.max(1, Math.ceil(frac * n)));
  return { train: sorted.slice(0, n - k), holdout: sorted.slice(n - k) };
}

/** Mean absolute percentage error, as a fraction (0.12 = 12%). Null for no rows. */
export function mape(rows: ReadonlyArray<{ predicted: number; actual: number }>): number | null {
  if (rows.length === 0) return null;
  return rows.reduce((a, r) => a + Math.abs(r.predicted - r.actual) / r.actual, 0) / rows.length;
}

export interface HoldoutEvaluation {
  metrics: BacktestMetrics;
  /** Holdout rows that entered at least one metric. */
  usable: number;
}

/**
 * Hours and quantity MAPE of both sets on the same holdout rows: rows with a usable actual
 * (> 0, the same rule calibration applies) that both sets can predict.
 */
export function evaluateHoldout(
  holdout: readonly Observation[],
  active: CoefficientSet,
  candidate: CoefficientSet,
): HoldoutEvaluation {
  type Row = { predicted: number; actual: number };
  const hours: { a: Row[]; c: Row[] } = { a: [], c: [] };
  const qty: { a: Row[]; c: Row[] } = { a: [], c: [] };
  let usable = 0;
  for (const o of holdout) {
    let used = false;
    const actualHours = usableAmount(o.actualHours);
    if (actualHours !== null) {
      const pa = predictHours(active, o);
      const pc = predictHours(candidate, o);
      if (pa !== null && pc !== null) {
        hours.a.push({ predicted: pa, actual: actualHours });
        hours.c.push({ predicted: pc, actual: actualHours });
        used = true;
      }
    }
    const actualQty = usableAmount(o.actualQty);
    if (actualQty !== null) {
      const pa = predictQty(active, o);
      const pc = predictQty(candidate, o);
      if (pa !== null && pc !== null) {
        qty.a.push({ predicted: pa, actual: actualQty });
        qty.c.push({ predicted: pc, actual: actualQty });
        used = true;
      }
    }
    if (used) usable++;
  }
  return {
    metrics: {
      n: holdout.length,
      hoursMapeActive: mape(hours.a),
      hoursMapeCandidate: mape(hours.c),
      qtyMapeActive: mape(qty.a),
      qtyMapeCandidate: mape(qty.c),
    },
    usable,
  };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/**
 * The 'backtest' gate. Passes when the candidate's MAPE is no worse than the active set's for
 * every metric with data. Without a holdout (too few observations) or with fewer than
 * MIN_HOLDOUT_ROWS usable rows it passes but is not `sufficient`, so it cannot auto-promote.
 */
export function backtestGate(
  evaluation: HoldoutEvaluation | null,
  nObservations: number,
): { gate: GateResult; sufficient: boolean } {
  if (!evaluation) {
    return {
      gate: {
        name: 'backtest',
        passed: true,
        detail: `Insufficient data for a holdout: ${nObservations} observation(s), need ${MIN_BACKTEST_N}. Not auto-promotable.`,
      },
      sufficient: false,
    };
  }
  const { metrics: m, usable } = evaluation;
  const summary =
    `Holdout ${m.n} row(s), ${usable} usable. Hours MAPE active ${pct(m.hoursMapeActive)} vs candidate ${pct(m.hoursMapeCandidate)}; ` +
    `quantity MAPE active ${pct(m.qtyMapeActive)} vs candidate ${pct(m.qtyMapeCandidate)}.`;
  if (usable < MIN_HOLDOUT_ROWS) {
    return {
      gate: { name: 'backtest', passed: true, detail: `Insufficient holdout (need ${MIN_HOLDOUT_ROWS} usable rows). ${summary}` },
      sufficient: false,
    };
  }
  const worse: string[] = [];
  if (m.hoursMapeActive !== null && m.hoursMapeCandidate !== null && worseThan(m.hoursMapeCandidate, m.hoursMapeActive))
    worse.push('hours');
  if (m.qtyMapeActive !== null && m.qtyMapeCandidate !== null && worseThan(m.qtyMapeCandidate, m.qtyMapeActive))
    worse.push('quantity');
  return {
    gate: {
      name: 'backtest',
      passed: worse.length === 0,
      detail: worse.length === 0 ? summary : `Candidate is worse on ${worse.join(' and ')}. ${summary}`,
    },
    sufficient: true,
  };
}

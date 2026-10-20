// Win-probability model and price optimizer (PLAN.md §6.6). A weighted, L2-regularized
// logistic regression on markup, job size, job type and lead source, fitted by IRLS, plus the
// expected-profit scan shown next to the estimator's price. Pure: callers pass `now`.
import { money, roundUpTo, type PricingSettings, type WinModel } from '@/lib/pricing';
import type { PricePoint, PriceRecommendation, WinFeatures, WinObservation, WinRateBucket } from './types';

const P_MIN = 1e-6; // predictions are clamped to [P_MIN, 1 - P_MIN]
const MAX_ITER = 50;
const TOL = 1e-8; // IRLS stops when no weight moves more than this
const MAX_HALVINGS = 30;
const RIDGE_EPS = 1e-9; // keeps the Hessian invertible when a feature is constant
const MARGIN_STEP = 0.005;
const MIN_SOURCE_QUOTES = 5; // a lead source needs this many quotes to get its own weight
const UNKNOWN_SOURCE = 'Unknown';
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/** P(win) in (0,1) for a quote with these features. */
export function predictWin(model: WinModel, f: WinFeatures): number {
  const w = (name: string) => {
    const v = Object.prototype.hasOwnProperty.call(model.weights, name) ? model.weights[name] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  // Unknown job types and sources have no weight, i.e. they score as the reference level.
  const z =
    w('intercept') +
    w('markup') * f.markup +
    w('log_sqft') * logSqft(f.sqft) +
    w(`job:${f.jobType}`) +
    w(`source:${sourceName(f.source)}`);
  return clampP(Number.isNaN(z) ? model.metrics.baseRate : sigmoid(z));
}

/**
 * Scans margins from floorMarginPct to ceilingMarginPct (0.5-point steps), prices each as
 * roundUpTo(max(loadedCost / (1 - m), minimumJobPrice), priceRounding), and returns the point
 * with the highest expected profit P(win) x (price - loadedCost), plus the whole curve.
 * Returns null when loadedCost <= 0.
 */
export function recommendPrice(
  model: WinModel,
  loadedCost: number,
  f: Omit<WinFeatures, 'markup'>,
  settings: Pick<PricingSettings, 'floorMarginPct' | 'ceilingMarginPct' | 'priceRounding' | 'minimumJobPrice'>,
): PriceRecommendation | null {
  if (!(loadedCost > 0) || !Number.isFinite(loadedCost)) return null;
  const curve: PricePoint[] = [];
  const seen = new Set<number>();
  for (const m of marginGrid(settings.floorMarginPct, settings.ceilingMarginPct)) {
    const price = roundUpTo(Math.max(loadedCost / (1 - m), settings.minimumJobPrice), settings.priceRounding);
    // The minimum job price and rounding make neighbouring margins land on the same price.
    if (!Number.isFinite(price) || seen.has(price)) continue;
    seen.add(price);
    const winProbability = predictWin(model, { ...f, markup: price / loadedCost });
    curve.push({
      price,
      marginPct: round4((price - loadedCost) / price),
      winProbability,
      expectedProfit: money(winProbability * (price - loadedCost)),
    });
  }
  // Prices only rise with the margin, so keeping the first maximum breaks ties toward the lower price.
  let best: PricePoint | null = null;
  for (const p of curve) if (!best || p.expectedProfit > best.expectedProfit) best = p;
  return best ? { ...best, curve } : null;
}

/** Floor to ceiling inclusive in MARGIN_STEP steps; margins >= 100% cannot be priced. */
function marginGrid(floor: number, ceiling: number): number[] {
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling)) return [];
  // A ceiling below the floor is a configuration slip: never recommend below the floor.
  const hi = Math.max(floor, ceiling);
  const steps = Math.floor((hi - floor) / MARGIN_STEP + 1e-9);
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) out.push(Math.round((floor + i * MARGIN_STEP) * 1e9) / 1e9);
  if (hi - out[out.length - 1]! > 1e-9) out.push(hi);
  return out.filter((m) => m < 1);
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

interface Prepared {
  x: number[][];
  y: number[];
  w: number[];
}

/**
 * Weighted (recency half-life) L2-regularized logistic regression fitted by IRLS.
 * Returns model null with a reason when there are fewer than minQuotes decided quotes or
 * only one outcome class.
 *
 * Details: quotes with a non-finite or non-positive markup, a non-finite sqft or an
 * unparseable decidedAt are skipped. Recency weights w = 0.5^(age/halfLifeDays) (age from
 * decidedAt to now, never negative) are rescaled to average 1, so `l2` means the same however
 * old the data is. The objective is the weighted negative log-likelihood plus
 * (l2/2) x the sum of squared weights, intercept excluded.
 */
export function trainWinModel(
  obs: WinObservation[],
  opts: { now: Date; halfLifeDays: number; l2: number; minQuotes: number },
): { model: Omit<WinModel, 'id' | 'trainedAt'> | null; reason: string } {
  const nowMs = opts.now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('trainWinModel: now must be a valid date');

  const usable = obs.filter(
    (o) => Number.isFinite(o.markup) && o.markup > 0 && Number.isFinite(o.sqft) && Number.isFinite(Date.parse(o.decidedAt)),
  );
  const n = usable.length;
  const wins = usable.filter((o) => o.won).length;
  const skipped = obs.length - n;
  const skippedNote = skipped > 0 ? ` (${skipped} skipped for missing data)` : '';

  if (n === 0) return { model: null, reason: `No decided quotes yet${skippedNote}; showing win rates by bucket only.` };
  if (n < opts.minQuotes) {
    return {
      model: null,
      reason: `Only ${n} decided ${plural(n, 'quote')}${skippedNote}; the win model needs at least ${opts.minQuotes}. Showing win rates by bucket only.`,
    };
  }
  if (wins === 0 || wins === n) {
    return {
      model: null,
      reason: `All ${n} decided ${plural(n, 'quote')} were ${wins === 0 ? 'lost' : 'won'}; the win model needs both wins and losses.`,
    };
  }

  // Categorical levels: the most frequent is the reference (weight 0); rare sources fold into it.
  const jobTypes = levels(usable.map((o) => o.jobType), 1);
  const sources = levels(usable.map((o) => sourceName(o.source)), MIN_SOURCE_QUOTES);
  const names = ['intercept', 'markup', 'log_sqft', ...jobTypes.map((j) => `job:${j}`), ...sources.map((s) => `source:${s}`)];
  const index = new Map(names.map((name, i) => [name, i]));

  const w = recencyWeights(usable, nowMs, opts.halfLifeDays);
  const sumW = sum(w);
  const baseRate = w.reduce((acc, wi, i) => acc + wi * (usable[i]!.won ? 1 : 0), 0) / sumW;
  // Recency can leave one class with (numerically) zero weight: as good as a single class.
  if (!(baseRate > 0 && baseRate < 1)) {
    return {
      model: null,
      reason: `Recent decided quotes were all ${baseRate > 0 ? 'won' : 'lost'} once older ones are down-weighted; the win model needs both wins and losses.`,
    };
  }

  const data: Prepared = {
    x: usable.map((o) => {
      const row = new Array<number>(names.length).fill(0);
      row[0] = 1;
      row[1] = o.markup;
      row[2] = logSqft(o.sqft);
      const j = index.get(`job:${o.jobType}`);
      if (j !== undefined) row[j] = 1;
      const s = index.get(`source:${sourceName(o.source)}`);
      if (s !== undefined) row[s] = 1;
      return row;
    }),
    y: usable.map((o) => (o.won ? 1 : 0)),
    w,
  };
  const l2 = Number.isFinite(opts.l2) && opts.l2 > 0 ? opts.l2 : 0;
  const fit = fitLogistic(data, l2);

  // Metrics on the training data: weighted log-loss and base rate; AUC is unweighted (ranking only).
  const scores = data.x.map((row) => dot(row, fit.beta));
  const logLoss = data.w.reduce((acc, wi, i) => acc + wi * nll(scores[i]!, data.y[i]!), 0) / sumW;

  const weights: Record<string, number> = {};
  names.forEach((name, i) => (weights[name] = fit.beta[i]!));

  return {
    model: { nQuotes: n, weights, jobTypes, sources, metrics: { logLoss, auc: auc(scores, data.y), baseRate } },
    reason:
      `Trained on ${n} decided ${plural(n, 'quote')} (${wins} won)${skippedNote}.` +
      (fit.converged ? '' : ` The fit stopped after ${fit.iterations} iterations without fully converging.`),
  };
}

/** Recency weights rescaled to mean 1; computed in log space so very old data never underflows to 0. */
function recencyWeights(obs: WinObservation[], nowMs: number, halfLifeDays: number): number[] {
  if (!(halfLifeDays > 0) || !Number.isFinite(halfLifeDays)) return obs.map(() => 1);
  const logW = obs.map((o) => {
    const ageDays = Math.max(0, (nowMs - Date.parse(o.decidedAt)) / DAY_MS);
    return -(ageDays / halfLifeDays) * Math.LN2;
  });
  const top = logW.reduce((m, l) => Math.max(m, l), -Infinity);
  const raw = logW.map((l) => Math.exp(l - top));
  const scale = obs.length / sum(raw);
  return raw.map((r) => r * scale);
}

/** Levels with their own weight: all but the most frequent, and only those seen >= minCount times. */
function levels(values: string[], minCount: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
  return ranked
    .slice(1)
    .filter(([, c]) => c >= minCount)
    .map(([v]) => v)
    .sort(compare);
}

/**
 * Newton's method (IRLS) on the penalized weighted negative log-likelihood, with step-halving
 * so every accepted step lowers the objective. Starts at the weighted base rate.
 */
function fitLogistic(d: Prepared, l2: number): { beta: number[]; iterations: number; converged: boolean } {
  const k = d.x[0]!.length;
  const penalty = (j: number) => (j === 0 ? 0 : l2);
  const objective = (b: number[]) => {
    let total = 0;
    d.x.forEach((row, i) => (total += d.w[i]! * nll(dot(row, b), d.y[i]!)));
    for (let j = 1; j < k; j++) total += 0.5 * l2 * b[j]! * b[j]!;
    return total;
  };

  const rate = d.w.reduce((acc, wi, i) => acc + wi * d.y[i]!, 0) / sum(d.w);
  let beta = new Array<number>(k).fill(0);
  beta[0] = Math.log(rate / (1 - rate));
  let obj = objective(beta);

  for (let iter = 1; iter <= MAX_ITER; iter++) {
    const grad = new Array<number>(k).fill(0);
    const hess = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    d.x.forEach((row, i) => {
      const mu = sigmoid(dot(row, beta));
      const r = d.w[i]! * (mu - d.y[i]!);
      const s = d.w[i]! * mu * (1 - mu);
      for (let a = 0; a < k; a++) {
        grad[a]! += r * row[a]!;
        for (let b = 0; b <= a; b++) hess[a]![b]! += s * row[a]! * row[b]!;
      }
    });
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < a; b++) hess[b]![a] = hess[a]![b]!;
      grad[a]! += penalty(a) * beta[a]!;
      hess[a]![a]! += penalty(a) + RIDGE_EPS;
    }

    const step = solve(hess, grad);
    if (!step) return { beta, iterations: iter, converged: false };
    let accepted: number[] | null = null;
    let next = obj;
    for (let h = 0, t = 1; h <= MAX_HALVINGS && !accepted; h++, t /= 2) {
      const cand = beta.map((v, j) => v - t * step[j]!);
      const value = objective(cand);
      if (value <= obj + 1e-12 * (1 + Math.abs(obj))) {
        accepted = cand;
        next = value;
      }
    }
    // No step lowers the objective: we are at the optimum up to floating-point noise.
    if (!accepted) return { beta, iterations: iter, converged: maxAbs(step) < 1e-6 };
    const moved = maxAbs(accepted.map((v, j) => v - beta[j]!));
    beta = accepted;
    obj = next;
    if (moved < TOL) return { beta, iterations: iter, converged: true };
  }
  return { beta, iterations: MAX_ITER, converged: false };
}

/** Solves A x = b by Gaussian elimination with partial pivoting. Null when A is singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    const p = m[pivot]![col]!;
    if (!(Math.abs(p) > 1e-300)) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = col + 1; r < n; r++) {
      const factor = m[r]![col]! / p;
      for (let c = col; c <= n; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = m[r]![n]!;
    for (let c = r + 1; c < n; c++) acc -= m[r]![c]! * x[c]!;
    x[r] = acc / m[r]![r]!;
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Area under the ROC curve via Mann-Whitney U (ties count half). Null with one class. */
function auc(scores: number[], y: number[]): number | null {
  const nPos = y.filter((v) => v === 1).length;
  const nNeg = y.length - nPos;
  if (nPos === 0 || nNeg === 0) return null;
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.s === order[start]!.s) end++;
    const avgRank = (start + end) / 2 + 1;
    for (let r = start; r <= end; r++) if (y[order[r]!.i] === 1) rankSumPos += avgRank;
    start = end + 1;
  }
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

// ---------------------------------------------------------------------------
// Buckets (dashboard; works at any n)
// ---------------------------------------------------------------------------

const MARKUP_BANDS: Array<{ label: string; below: number }> = [
  { label: '<1.4×', below: 1.4 },
  { label: '1.4–1.6×', below: 1.6 },
  { label: '1.6–1.8×', below: 1.8 },
  { label: '1.8–2.0×', below: 2.0 },
  { label: '2.0×+', below: Infinity },
];

/** Win rate by markup band, job type and lead source, for the dashboard (works at any n). */
export function winRateBuckets(obs: WinObservation[]): {
  byMarkup: WinRateBucket[];
  byJobType: WinRateBucket[];
  bySource: WinRateBucket[];
} {
  // Every band is always present (zero counts allowed); a non-finite markup fits no band.
  const byMarkup = MARKUP_BANDS.map((band, i) => {
    const from = i === 0 ? -Infinity : MARKUP_BANDS[i - 1]!.below;
    return bucket(band.label, obs.filter((o) => Number.isFinite(o.markup) && o.markup >= from && o.markup < band.below));
  });
  return {
    byMarkup,
    byJobType: groupBuckets(obs, (o) => o.jobType),
    bySource: groupBuckets(obs, (o) => sourceName(o.source)),
  };
}

/** One bucket per distinct key, most quotes first (ties alphabetical). */
function groupBuckets(obs: WinObservation[], key: (o: WinObservation) => string): WinRateBucket[] {
  const groups = new Map<string, WinObservation[]>();
  for (const o of obs) {
    const k = key(o);
    const list = groups.get(k);
    if (list) list.push(o);
    else groups.set(k, [o]);
  }
  return [...groups]
    .map(([label, list]) => bucket(label, list))
    .sort((a, b) => b.quotes - a.quotes || compare(a.label, b.label));
}

function bucket(label: string, list: WinObservation[]): WinRateBucket {
  const wins = list.filter((o) => o.won).length;
  return { label, quotes: list.length, wins, winRate: list.length ? wins / list.length : 0 };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Null or blank lead source -> 'Unknown' (training, prediction and buckets agree). */
function sourceName(source: string | null): string {
  return source?.trim() || UNKNOWN_SOURCE;
}

/** ln(max(sqft, 1)); a missing size scores like a 1 sq ft job (contributes 0). */
function logSqft(sqft: number): number {
  return Number.isFinite(sqft) && sqft > 1 ? Math.log(sqft) : 0;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** -log P(y | z) without overflow: softplus(z) - y z. */
function nll(z: number, y: number): number {
  const softplus = z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
  return softplus - y * z;
}

function clampP(p: number): number {
  if (Number.isNaN(p)) return 0.5;
  return Math.min(1 - P_MIN, Math.max(P_MIN, p));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const dot = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + v * b[i]!, 0);
const maxAbs = (xs: number[]) => xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

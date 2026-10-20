// Recency weights and weighted statistics (PLAN.md §6.3). Recent jobs count more; old jobs
// fade with a half-life so the coefficients follow crews, materials and seasons as they change.

export const DAY_MS = 86_400_000;

/** Days from `at` (ISO) to `now`, never negative (future dates count as today). NaN when `at` is not a date. */
export function ageDays(at: string, now: Date): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return Number.NaN;
  return Math.max(0, (now.getTime() - t) / DAY_MS);
}

/**
 * w = 0.5^(age / halfLife). An unknown age (NaN) weighs nothing; a half-life that is not
 * positive disables decay (every observation weighs 1).
 */
export function recencyWeight(age: number, halfLifeDays: number): number {
  if (Number.isNaN(age)) return 0;
  if (!(halfLifeDays > 0)) return 1;
  return Math.pow(0.5, Math.max(0, age) / halfLifeDays);
}

/** Kish effective sample size: n_eff = (Σw)² / Σw². 0 for no (or only zero) weights. */
export function effectiveSampleSize(weights: readonly number[]): number {
  let s = 0;
  let s2 = 0;
  for (const w of weights) {
    s += w;
    s2 += w * w;
  }
  return s2 > 0 ? (s * s) / s2 : 0;
}

/** Σ w·x / Σ w, or null when the weights sum to zero. */
export function weightedMean(values: readonly number[], weights: readonly number[]): number | null {
  let sw = 0;
  let swx = 0;
  values.forEach((x, i) => {
    const w = weights[i] ?? 0;
    sw += w;
    swx += w * x;
  });
  return sw > 0 ? swx / sw : null;
}

/** Weighted standard deviation about the weighted mean: sqrt(Σ w (x − m)² / Σ w). */
export function weightedSd(values: readonly number[], weights: readonly number[]): number | null {
  const m = weightedMean(values, weights);
  if (m === null) return null;
  let sw = 0;
  let ss = 0;
  values.forEach((x, i) => {
    const w = weights[i] ?? 0;
    sw += w;
    ss += w * (x - m) * (x - m);
  });
  return Math.sqrt(ss / sw);
}

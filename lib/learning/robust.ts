// Robustness (PLAN.md §6.3): one mis-keyed actual must not drag a coefficient. Ratios are
// winsorized at weighted quantiles within each fitting group before they are averaged.

/** Groups smaller than this are left alone: with a handful of jobs every point matters. */
export const MIN_WINSOR_N = 5;

/**
 * Weighted winsorizing limits, never interpolated (an outlier is pulled all the way in to a
 * real neighbouring value, not halfway): `lo` is the smallest value whose cumulative weight
 * from the bottom exceeds pct · W, `hi` the largest whose cumulative weight from the top does.
 * With n equal weights that clips pct · n values at each end (5% of 20 jobs: one per side).
 * Symmetric by construction. Zero-weight and non-finite values are ignored; null when nothing
 * is left or pct is outside [0, 0.5).
 */
export function winsorLimits(
  values: readonly number[],
  weights: readonly number[],
  pct: number,
): { lo: number; hi: number } | null {
  if (!(pct >= 0 && pct < 0.5)) return null;
  const pts = values
    .map((x, i) => ({ x, w: weights[i] ?? 0 }))
    .filter((p) => p.w > 0 && Number.isFinite(p.x))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) return null;
  const cut = pct * pts.reduce((a, p) => a + p.w, 0);
  // Walk in from one end until the weight passed exceeds the cut (cut < W / 2, so it always does).
  const first = (ordered: typeof pts) => {
    let i = 0;
    let cum = ordered[0]!.w;
    while (cum <= cut && i < ordered.length - 1) cum += ordered[++i]!.w;
    return ordered[i]!.x;
  };
  return { lo: first(pts), hi: first([...pts].reverse()) };
}

/**
 * Clips values to the weighted [pct, 1 − pct] limits. Groups with fewer than `minN` values, or
 * pct <= 0, come back unchanged (always as a new array).
 */
export function winsorize(
  values: readonly number[],
  weights: readonly number[],
  pct: number,
  minN: number = MIN_WINSOR_N,
): number[] {
  const limits = values.length >= minN && pct > 0 ? winsorLimits(values, weights, pct) : null;
  if (!limits) return [...values];
  return values.map((x) => Math.min(Math.max(x, limits.lo), limits.hi));
}

// Weighted least squares for the hours model (PLAN.md §6.3): hours = setup + x · rate, where
// x = design units × access multiplier. Closed form on centred data, so a bulk of large jobs
// (thousands of board feet) does not cost precision.

export interface WeightedPoint {
  x: number;
  y: number;
  w: number;
}

export interface Line {
  intercept: number;
  slope: number;
}

/**
 * Weighted simple linear regression y = intercept + slope · x. Null when the weights sum to
 * zero, x has (numerically) no spread, or the result is not finite.
 */
export function wlsLine(points: readonly WeightedPoint[]): Line | null {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sw += p.w;
    sx += p.w * p.x;
    sy += p.w * p.y;
  }
  if (!(sw > 0)) return null;
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    sxx += p.w * dx * dx;
    sxy += p.w * dx * (p.y - my);
  }
  // Spread relative to the scale of x: below this the slope is noise.
  if (!(sxx > 1e-12 * sw * (mx * mx + 1))) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  return Number.isFinite(slope) && Number.isFinite(intercept) ? { intercept, slope } : null;
}

/** Number of distinct x values (exact comparison). */
export function distinctCount(xs: readonly number[]): number {
  return new Set(xs).size;
}

// Weighted least squares for the hours model (PLAN.md §6.3): hours = setup + x · rate, where
// x = design units × access multiplier. The simple line is closed form on centred data and the
// multi-coefficient fit uses QR, so a bulk of large jobs (thousands of board feet) does not
// cost precision.

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

export interface WeightedRow {
  x: readonly number[]; // one value per coefficient (1 for an intercept)
  y: number;
  w: number;
}

/**
 * A column whose part outside the span of the columns before it is shorter than this fraction
 * of its own length adds nothing the others cannot express: the system is singular.
 */
const RANK_TOL = 1e-9;

/**
 * Weighted least squares y = Σ βⱼ · xⱼ with any number of coefficients, by Householder QR of
 * the √w-scaled rows. QR never forms XᵀWX, so an intercept next to columns in the thousands
 * keeps its precision. Rows without a positive weight are ignored. Null when fewer rows than
 * coefficients remain, a column is (numerically) a combination of the others, or the result is
 * not finite. Every row must have as many x values as the first.
 */
export function wlsSolve(rows: readonly WeightedRow[]): number[] | null {
  const used = rows.filter((r) => r.w > 0);
  const p = rows[0]?.x.length ?? 0;
  const m = used.length;
  if (p === 0 || m < p) return null;
  // Column-major √W·X, reduced in place to R (upper triangle) while b becomes Qᵀ·√W·y.
  const a = Array.from({ length: p }, (_, j) => used.map((r) => Math.sqrt(r.w) * r.x[j]!));
  const b = used.map((r) => Math.sqrt(r.w) * r.y);
  const length = a.map((col) => Math.sqrt(col.reduce((s, v) => s + v * v, 0)));
  for (let k = 0; k < p; k++) {
    const col = a[k]!;
    let ss = 0;
    for (let i = k; i < m; i++) ss += col[i]! * col[i]!;
    const alpha = Math.sqrt(ss);
    if (!(alpha > RANK_TOL * length[k]!)) return null;
    // Reflect col[k..] onto r·e₁; r takes the sign opposite to col[k] so v does not cancel.
    const r = col[k]! >= 0 ? -alpha : alpha;
    const v = col.slice(k);
    v[0]! -= r;
    const vv = 2 * (ss - r * col[k]!);
    const reflect = (target: number[]) => {
      let t = 0;
      for (let i = 0; i < v.length; i++) t += v[i]! * target[k + i]!;
      const f = (2 * t) / vv;
      for (let i = 0; i < v.length; i++) target[k + i]! -= f * v[i]!;
    };
    for (let j = k + 1; j < p; j++) reflect(a[j]!);
    reflect(b);
    col[k] = r;
  }
  // Back substitution: R·β = (Qᵀ·√W·y)[0..p).
  const beta = new Array<number>(p).fill(0);
  for (let k = p - 1; k >= 0; k--) {
    let t = b[k]!;
    for (let j = k + 1; j < p; j++) t -= a[j]![k]! * beta[j]!;
    beta[k] = t / a[k]![k]!;
  }
  return beta.every(Number.isFinite) ? beta : null;
}

/** Number of distinct x values (exact comparison). */
export function distinctCount(xs: readonly number[]): number {
  return new Set(xs).size;
}

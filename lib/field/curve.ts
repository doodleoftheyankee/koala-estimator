// Scales a win-chance curve (price -> P(win)) into SVG coordinates for the small chart next to
// each option's price. Pure; the component only draws what this returns.

export interface ChartBox {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
}

export interface CurvePoint {
  price: number;
  winProbability: number;
}

export interface ScaledCurve {
  /** SVG path ("M x y L x y ...") through the curve, cheapest price first. */
  path: string;
  /** Price -> x; prices outside the domain are clamped to the plot edge. */
  x: (price: number) => number;
  /** Win probability (0..1) -> y; 1 is at the top. Clamped to [0, 1]. */
  y: (p: number) => number;
  /** Price range on the x axis (curve plus any extra prices, e.g. the estimator's own). */
  domain: { min: number; max: number };
  plot: { left: number; right: number; top: number; bottom: number };
}

/**
 * Null when no point is usable. `include` widens the price domain so markers such as the
 * estimator's current price stay on the chart even when it is outside the scanned range.
 * A single price (or identical prices) gets a small symmetric range instead of dividing by zero.
 */
export function scaleCurve(curve: readonly CurvePoint[], box: ChartBox, include: readonly number[] = []): ScaledCurve | null {
  const pts = curve
    .filter((p) => Number.isFinite(p.price) && Number.isFinite(p.winProbability))
    .sort((a, b) => a.price - b.price);
  if (pts.length === 0) return null;

  const prices = [...pts.map((p) => p.price), ...include.filter(Number.isFinite)];
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (!(max - min > 1e-9)) {
    const pad = Math.max(1, Math.abs(min) * 0.05);
    min -= pad;
    max += pad;
  }

  const left = box.pad.left;
  const top = box.pad.top;
  const right = Math.max(left, box.width - box.pad.right);
  const bottom = Math.max(top, box.height - box.pad.bottom);

  const x = (price: number) => {
    const t = Number.isFinite(price) ? (clamp(price, min, max) - min) / (max - min) : 0;
    return left + t * (right - left);
  };
  const y = (p: number) => bottom - clamp(Number.isFinite(p) ? p : 0, 0, 1) * (bottom - top);

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(x(p.price))} ${fmt(y(p.winProbability))}`).join(' ');
  return { path, x, y, domain: { min, max }, plot: { left, right, top, bottom } };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Two decimals, no "-0". */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r === 0 ? 0 : r);
}

// Actual vs estimate variance for the office jobs page. Pure.

export type VarianceTone = 'green' | 'amber' | 'red';

/** Within this fraction of the estimate reads as on target (green), then close (amber), then off (red). */
export const VARIANCE_BANDS = { green: 0.1, amber: 0.25 } as const;

// Ratios like 1.1 / 1 - 1 land a hair above 0.1 in floating point; treat them as on the line.
const EPS = 1e-9;

const usable = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Signed (actual - estimated) / estimated, or null when either side is missing or the estimate is not positive. */
export function variancePct(estimated: number | null | undefined, actual: number | null | undefined): number | null {
  if (!usable(estimated) || !usable(actual) || estimated <= 0) return null;
  return (actual - estimated) / estimated;
}

export function varianceTone(pct: number | null): VarianceTone | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const a = Math.abs(pct);
  if (a <= VARIANCE_BANDS.green + EPS) return 'green';
  if (a <= VARIANCE_BANDS.amber + EPS) return 'amber';
  return 'red';
}

/** "+12%", "−8%", "0%" (whole percent; a real minus sign). */
export function formatVariance(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const rounded = Math.round(pct * 100);
  if (rounded === 0) return '0%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

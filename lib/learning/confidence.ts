// Confidence score shown next to every coefficient (PLAN.md §6.3): more effective evidence and
// tighter agreement between jobs both raise it.
import { weightedSd } from './weights';

/** SE = weighted sd of the per-observation implied values / sqrt(n_eff). Null without evidence. */
export function standardError(values: readonly number[], weights: readonly number[], nEff: number): number | null {
  if (values.length === 0 || !(nEff > 0)) return null;
  const sd = weightedSd(values, weights);
  return sd === null ? null : sd / Math.sqrt(nEff);
}

/**
 * conf = 100 · (1 − exp(−n_eff / 8)) · clamp(1 − SE / |value|, 0, 1), always in [0, 100].
 * A missing SE (no evidence) or a zero/non-finite value scores 0.
 */
export function confidenceScore(nEff: number, value: number, se: number | null): number {
  if (!(nEff > 0) || se === null || !Number.isFinite(value) || value === 0) return 0;
  const relSe = se / Math.abs(value);
  const agreement = Number.isFinite(relSe) ? Math.min(Math.max(1 - relSe, 0), 1) : 0;
  return 100 * (1 - Math.exp(-nEff / 8)) * agreement;
}

// SKELETON: replaced by the implementation. Signatures are the contract.
import type { PricingSettings, WinModel } from '@/lib/pricing';
import type { PriceRecommendation, WinFeatures, WinObservation, WinRateBucket } from './types';

/** P(win) in (0,1) for a quote with these features. */
export function predictWin(model: WinModel, f: WinFeatures): number {
  void model;
  void f;
  throw new Error('not implemented');
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
  void model;
  void loadedCost;
  void f;
  void settings;
  throw new Error('not implemented');
}

/**
 * Weighted (recency half-life) L2-regularized logistic regression fitted by IRLS.
 * Returns model null with a reason when there are fewer than minQuotes decided quotes or
 * only one outcome class.
 */
export function trainWinModel(
  obs: WinObservation[],
  opts: { now: Date; halfLifeDays: number; l2: number; minQuotes: number },
): { model: Omit<WinModel, 'id' | 'trainedAt'> | null; reason: string } {
  void obs;
  void opts;
  throw new Error('not implemented');
}

/** Win rate by markup band, job type and lead source, for the dashboard (works at any n). */
export function winRateBuckets(obs: WinObservation[]): {
  byMarkup: WinRateBucket[];
  byJobType: WinRateBucket[];
  bySource: WinRateBucket[];
} {
  void obs;
  throw new Error('not implemented');
}

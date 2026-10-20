// Expected-profit price advice on the phone (PLAN.md §6.6). Scores each option with the cached
// win model, offline: the win chance at the estimator's price and the price that maximizes
// P(win) x (price - loaded cost). The features mirror how the model was trained
// (lib/learning/observations.ts winObservationFromQuote): the largest area's job type and the
// total square footage of the priced areas. Pure.
import { money, type PricedOption, type PricingSettings, type WinModel } from '@/lib/pricing';
import { predictWin, recommendPrice } from '@/lib/learning/winRate';
import type { PriceRecommendation, WinFeatures } from '@/lib/learning/types';

type SizedArea = { jobType: string; sqft: number };

/** Job type of the largest area (the first one on a tie); null when there are no sized areas. */
export function primaryJobType<A extends SizedArea>(areas: readonly A[]): A['jobType'] | null {
  let best: A | null = null;
  for (const a of areas) {
    if (!Number.isFinite(a.sqft)) continue;
    if (!best || a.sqft > best.sqft) best = a;
  }
  return best ? best.jobType : null;
}

/** Sum of the areas' square footage (non-finite sizes count as 0). */
export function totalSqft(areas: readonly SizedArea[]): number {
  return areas.reduce((acc, a) => acc + (Number.isFinite(a.sqft) ? a.sqft : 0), 0);
}

/** Win-model features for an estimate: no lead source on the phone yet, so it scores as unknown. */
export function winFeaturesFor(areas: readonly SizedArea[]): Omit<WinFeatures, 'markup'> | null {
  const jobType = primaryJobType(areas);
  if (jobType === null) return null;
  return { jobType, source: null, sqft: totalSqft(areas) };
}

export interface PriceAdvice {
  /** The option as currently priced. expectedProfit is in dollars; show it only to people who may see costs. */
  current: { price: number; winProbability: number; expectedProfit: number };
  /** The best expected-profit point, with the whole curve for the chart. */
  best: PriceRecommendation;
  /** The current price already is the recommended one (to the cent). */
  atBest: boolean;
}

/** Null when the option has no usable cost or price, or the settings leave nothing to scan. */
export function priceAdvice(
  model: WinModel,
  option: Pick<PricedOption, 'price' | 'loadedCost'>,
  features: Omit<WinFeatures, 'markup'>,
  settings: Pick<PricingSettings, 'floorMarginPct' | 'ceilingMarginPct' | 'priceRounding' | 'minimumJobPrice'>,
): PriceAdvice | null {
  // The model comes from a bundle cached on the phone; a malformed one means no advice, never a crash.
  if (!model || typeof model.weights !== 'object' || model.weights === null) return null;
  const { price, loadedCost } = option;
  if (!(Number.isFinite(price) && price > 0 && Number.isFinite(loadedCost) && loadedCost > 0)) return null;
  const best = recommendPrice(model, loadedCost, features, settings);
  if (!best) return null;
  const winProbability = predictWin(model, { ...features, markup: price / loadedCost });
  return {
    current: { price, winProbability, expectedProfit: money(winProbability * (price - loadedCost)) },
    best,
    atBest: Math.abs(price - best.price) < 0.005,
  };
}

/** The reason stored with a price override taken from the recommendation. */
export function recommendationReason(model: Pick<WinModel, 'nQuotes'>): string {
  return `Expected-profit recommendation (win model, ${model.nQuotes} quotes)`;
}

/**
 * Would an estimator with this override limit be blocked from sending this price?
 * Mirrors canSendQuote: |price - modelPrice| / modelPrice > limit. Null limit = no limit.
 */
export function beyondOverrideLimit(price: number, modelPrice: number, limit: number | null): boolean {
  if (limit === null || !(modelPrice > 0) || !Number.isFinite(price)) return false;
  return Math.abs(price - modelPrice) / modelPrice > limit + 1e-9;
}

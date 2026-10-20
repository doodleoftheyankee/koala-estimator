import type { PricedOption, PricingSettings } from './types';

export type Role = 'owner' | 'office' | 'estimator' | 'crew';

export interface PolicyResult {
  ok: boolean;
  /** Human-readable reasons the action is blocked for this role. */
  reasons: string[];
}

/**
 * May this role send a quote containing these options?
 *  - crew never sends quotes
 *  - only the owner may send a price below the floor margin
 *  - estimators may move a price at most `estimatorOverrideLimitPct` from the model price
 */
export function canSendQuote(role: Role, options: PricedOption[], settings: PricingSettings): PolicyResult {
  if (role === 'crew') return { ok: false, reasons: ['Crew accounts cannot send quotes.'] };
  const reasons: string[] = [];
  for (const o of options) {
    if (o.belowFloor && role !== 'owner') {
      reasons.push(
        `${o.tier}: margin ${(o.marginPct * 100).toFixed(1)}% is below the ${(settings.floorMarginPct * 100).toFixed(0)}% floor. Owner approval required.`,
      );
    }
    if (role === 'estimator' && o.isOverridden && o.modelPrice > 0) {
      const delta = Math.abs(o.price - o.modelPrice) / o.modelPrice;
      if (delta > settings.estimatorOverrideLimitPct + 1e-9) {
        reasons.push(
          `${o.tier}: price is ${(delta * 100).toFixed(1)}% from the model price; estimators may change it up to ${(settings.estimatorOverrideLimitPct * 100).toFixed(0)}%. Ask the office to send.`,
        );
      }
    }
    if (o.isOverridden && !o.overrideReason?.trim()) {
      reasons.push(`${o.tier}: a price override needs a reason.`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

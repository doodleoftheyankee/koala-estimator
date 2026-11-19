import type { PricedOption, PricingSettings, Tier } from './types';

export type Role = 'owner' | 'office' | 'estimator' | 'crew';

/**
 * Why a quote cannot go out as it is:
 *  - crew: crews never send quotes;
 *  - below_floor: a price under the floor margin; only the owner may send it or approve it;
 *  - over_limit: an estimator's price further from the model price than they may go alone; the
 *    owner or the office may approve it;
 *  - no_reason / line_no_reason: a changed price or line needs a reason (no approval replaces it).
 */
export type PolicyProblemKind = 'crew' | 'below_floor' | 'over_limit' | 'no_reason' | 'line_no_reason';

export interface PolicyProblem {
  /** The option (null for a problem with the role itself). */
  tier: Tier | null;
  kind: PolicyProblemKind;
  /** One plain sentence, naming the price, the model price and what may be done. */
  message: string;
  /** below_floor / over_limit: the price asked (whole dollars) and the model price. */
  price?: number;
  modelPrice?: number;
  /** below_floor / over_limit: the lowest price the floor margin allows. */
  floor?: number;
  /** The range an estimator may quote alone (estimators only). */
  range?: { min: number; max: number };
  /** Who may approve this price: the owner only, or the owner or the office. */
  approver?: 'owner' | 'office';
  /** line_no_reason: the line's key and words. */
  lineKey?: string | null;
  line?: string;
}

export interface PolicyResult {
  ok: boolean;
  /** Human-readable reasons the action is blocked for this role (the problems' messages). */
  reasons: string[];
  problems: PolicyProblem[];
}

/**
 * A price the owner or the office approved for an estimator (table price_approvals). It is bound to
 * one estimate, one option, the exact whole-dollar price and the model price it was asked against.
 * The caller passes only the approvals of the estimate being sent.
 */
export interface PriceApproval {
  id: string;
  estimateId: string;
  tier: Tier;
  price: number;
  modelPrice: number;
  /** Below the floor margin when it was asked (only the owner may approve it). */
  belowFloor: boolean;
  status: 'pending' | 'approved' | 'declined';
  /** The role of whoever decided, recorded by the database (null while pending). */
  decidedRole: Role | null;
  note?: string | null;
  decisionNote?: string | null;
  requestedAt?: string;
  requestedBy?: string;
  decidedAt?: string | null;
}

const EPS = 1e-9;
const TIER_WORDS: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };
const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const percent = (n: number) => `${Math.round(n * 100)}%`;

/** The lowest whole-dollar price whose margin on the option's loaded cost reaches the floor margin. */
export function floorPrice(option: Pick<PricedOption, 'loadedCost'>, settings: Pick<PricingSettings, 'floorMarginPct'>): number {
  const raw = option.loadedCost / (1 - settings.floorMarginPct);
  return Math.max(1, Math.ceil(raw - 1e-6));
}

/**
 * The whole-dollar prices an estimator may quote alone: within the override limit of the model
 * price, and never under the floor margin. Null when there is no model price or no such price.
 */
export function estimatorRange(
  option: Pick<PricedOption, 'modelPrice' | 'loadedCost'>,
  settings: Pick<PricingSettings, 'estimatorOverrideLimitPct' | 'floorMarginPct'>,
): { min: number; max: number } | null {
  if (!(option.modelPrice > 0)) return null;
  const limit = settings.estimatorOverrideLimitPct;
  const min = Math.max(Math.ceil(option.modelPrice * (1 - limit) - 1e-6), floorPrice(option, settings));
  const max = Math.floor(option.modelPrice * (1 + limit) + 1e-6);
  return min <= max ? { min, max } : null;
}

/** Does this approval let the price through? Approved, same option, exact price and model price, by a role that may. */
export function approvalCovers(a: PriceApproval, p: Pick<PolicyProblem, 'tier' | 'kind' | 'price' | 'modelPrice'>): boolean {
  if (a.status !== 'approved' || a.tier !== p.tier || p.price === undefined || p.modelPrice === undefined) return false;
  if (Math.abs(a.price - p.price) > 0.005 || Math.abs(a.modelPrice - p.modelPrice) > 0.005) return false;
  if (p.kind === 'below_floor') return a.decidedRole === 'owner';
  if (p.kind === 'over_limit') return a.decidedRole === 'owner' || a.decidedRole === 'office';
  return false;
}

/**
 * May this role send a quote containing these options?
 *  - crew never sends quotes
 *  - only the owner may send a price below the floor margin (or approve one)
 *  - estimators may move a price at most `estimatorOverrideLimitPct` from the model price; the owner
 *    or the office may approve a price beyond it
 *  - every changed price or line needs a reason
 * `approvals` are the estimate's price approvals: an approved one lets its exact price through.
 */
export function canSendQuote(role: Role, options: PricedOption[], settings: PricingSettings, approvals: readonly PriceApproval[] = []): PolicyResult {
  if (role === 'crew') {
    const message = 'Crew accounts cannot send quotes.';
    return { ok: false, reasons: [message], problems: [{ tier: null, kind: 'crew', message }] };
  }
  const problems: PolicyProblem[] = [];
  for (const o of options) {
    const price = problemForPrice(role, o, settings);
    if (price && !approvals.some((a) => approvalCovers(a, price))) problems.push(price);
    if (o.isOverridden && !o.overrideReason?.trim()) {
      problems.push({ tier: o.tier, kind: 'no_reason', message: `${o.tier}: a price override needs a reason.` });
    }
    for (const l of o.lines) {
      if (l.isOverridden && !l.overrideReason?.trim()) {
        problems.push({ tier: o.tier, kind: 'line_no_reason', lineKey: l.key, line: l.description, message: `${o.tier}: "${l.description}" was changed without a reason.` });
      }
    }
  }
  return { ok: problems.length === 0, reasons: problems.map((p) => p.message), problems };
}

/** The option's price problem for this role, if any: below the floor margin, else beyond the estimator's limit. */
function problemForPrice(role: Role, o: PricedOption, settings: PricingSettings): PolicyProblem | null {
  const name = TIER_WORDS[o.tier];
  const floor = floorPrice(o, settings);
  const range = role === 'estimator' ? estimatorRange(o, settings) : null;
  const alone =
    role !== 'estimator'
      ? ''
      : range
        ? ` You can quote ${dollars(range.min)} to ${dollars(range.max)} on your own (estimators may change it up to ${percent(settings.estimatorOverrideLimitPct)}).`
        : ` With these changes no price you can quote on your own (within ${percent(settings.estimatorOverrideLimitPct)} of the model price) clears the ${percent(settings.floorMarginPct)} floor margin.`;
  const base = { tier: o.tier, price: o.price, modelPrice: o.modelPrice, floor, ...(range ? { range } : {}) };
  if (o.belowFloor && role !== 'owner') {
    return {
      ...base,
      kind: 'below_floor',
      approver: 'owner',
      message: `${name}: ${dollars(o.price)} is below the ${percent(settings.floorMarginPct)} floor margin; the lowest price it allows is ${dollars(floor)} (model price ${dollars(o.modelPrice)}).${alone} Only the owner can approve ${dollars(o.price)}.`,
    };
  }
  if (role === 'estimator' && (o.isOverridden || o.hasLineOverrides) && o.modelPrice > 0) {
    const delta = (o.price - o.modelPrice) / o.modelPrice;
    if (Math.abs(delta) > settings.estimatorOverrideLimitPct + EPS) {
      return {
        ...base,
        kind: 'over_limit',
        approver: 'office',
        message: `${name}: ${dollars(o.price)} is ${percent(Math.abs(delta))} ${delta < 0 ? 'below' : 'above'} the model price of ${dollars(o.modelPrice)}.${alone} Request approval to send ${dollars(o.price)}.`,
      };
    }
  }
  return null;
}

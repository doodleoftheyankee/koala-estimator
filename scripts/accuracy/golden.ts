// Golden sets: real and typical estimates priced again, so every fix shows what it does to every price.
// Shared by make-live-golden.ts, make-synthetic.ts and price-golden.ts.
import { priceEstimate, type AreaInput, type EstimateInput, type LineOverride, type PriceOverride, type PricingBundle, type Tier } from '@/lib/pricing';
import { checkPricedQuote, shownOptions, type Violation } from '@/lib/pricing/invariants';
import { checkSamePriceText, checkValidUntilIsExpiry, expectedHeadline, headlineInputFor, linkExpiresAt, sampleDraft, sampleQuote } from '@/lib/quotes/invariants';
import { areaSchema } from '@/lib/sync/draft';

/** One estimate of a golden set: the pricing input, the estimator's pick and when it is quoted. */
export interface GoldenEstimate {
  /** A stable key ("S1-F4", "T07") for the synthetic set; the estimate id for the live set. */
  key: string;
  id: string;
  title: string;
  input: EstimateInput;
  selectedTier: Tier | null;
  issuedAt: string;
  validDays: number;
  /** False for a live estimate never sent: it has no issue time, so no "Valid until" to check. */
  quoted?: boolean;
}

/** A live estimate as scripts/accuracy/golden-export.sql exports it. */
export interface LiveEstimate {
  id: string;
  status: string;
  selectedTier: Tier | null;
  driveMinutesEst: number | null;
  crewId: string | null;
  modelTotalPrice: number | null;
  createdAt: string;
  updatedAt: string;
  bundleHash: string | null;
  draft: {
    status: string | null;
    selectedTier: Tier | null;
    crewId: string | null;
    driveMinutesOneWay: number | null;
    areas: AreaInput[];
    overrides: Partial<Record<Tier, PriceOverride>>;
    lineOverrides: Record<string, LineOverride>;
  };
  options: Array<{ tier: Tier; label: string; price: number; modelPrice: number; isOverridden: boolean }>;
  quotes: Array<{
    version: number;
    status: string;
    sentAt: string | null;
    expiresAt: string;
    signedAt: string | null;
    signedTier: Tier | null;
    signedPrice: number | null;
    bundleHash: string | null;
    quoteNumber: string | null;
    issuedAt: string | null;
    validUntil: string | null;
    recommendedTier: Tier | null;
    prices: Partial<Record<Tier, number>>;
  }>;
}

export interface LiveExport {
  estimates: LiveEstimate[];
}

/** A live estimate as a golden estimate: the areas the phone would price, quoted when it was last sent (else last changed). */
export function liveGolden(e: LiveEstimate, validDays: number): GoldenEstimate {
  const latest = e.quotes[e.quotes.length - 1];
  return {
    key: e.id,
    id: e.id,
    title: e.id.slice(0, 8),
    input: {
      areas: e.draft.areas.filter((a) => areaSchema.safeParse(a).success),
      crewId: e.draft.crewId,
      driveMinutesOneWay: e.draft.driveMinutesOneWay,
      overrides: e.draft.overrides ?? {},
      lineOverrides: e.draft.lineOverrides ?? {},
    },
    selectedTier: e.draft.selectedTier ?? e.selectedTier,
    issuedAt: latest?.issuedAt ?? latest?.sentAt ?? e.updatedAt,
    validDays,
    quoted: !!latest,
  };
}

export interface PricedGoldenOption {
  tier: Tier;
  price: number;
  modelPrice: number;
  label: string;
  bullets: string[];
  items: Array<{ kind?: string; areaName: string; description: string; price: number }>;
}

export interface PricedGolden {
  key: string;
  id: string;
  title: string;
  options: PricedGoldenOption[];
  headline: { tier: Tier; price: number } | null;
  violations: Violation[];
  error?: string;
}

/** Prices one golden estimate as the app would quote it today, and checks every rule on it. */
export function priceGolden(g: GoldenEstimate, bundle: PricingBundle): PricedGolden {
  const base = { key: g.key, id: g.id, title: g.title };
  if (g.input.areas.length === 0) return { ...base, options: [], headline: null, violations: [] };
  try {
    const priced = priceEstimate(g.input, bundle.snapshot, bundle.coefficientSet);
    const shown = shownOptions(priced);
    const violations = checkPricedQuote({ input: g.input, priced, snapshot: bundle.snapshot, coefficients: bundle.coefficientSet });
    const draft = sampleDraft({ id: g.id, input: g.input, selectedTier: g.selectedTier, createdAt: g.issuedAt });
    const headline = headlineInputFor(draft, priced, bundle);
    if (shown.length) {
      const doc = sampleQuote(draft, { ...priced, options: shown }, g.issuedAt, g.validDays);
      violations.push(...checkSamePriceText(doc, headline));
      if (g.quoted !== false) violations.push(...checkValidUntilIsExpiry(doc, linkExpiresAt(g.issuedAt, g.validDays)));
    }
    return {
      ...base,
      options: shown.map((o) => ({
        tier: o.tier,
        price: o.price,
        modelPrice: o.modelPrice,
        label: o.label,
        bullets: o.bullets,
        items: o.customerItems.map((i) => ({ ...((i as { kind?: string }).kind ? { kind: (i as { kind?: string }).kind } : {}), areaName: i.areaName, description: i.description, price: i.price })),
      })),
      headline: expectedHeadline(headline),
      violations,
    };
  } catch (e) {
    return {
      ...base,
      options: [],
      headline: null,
      violations: [{ invariant: 'finite_amounts', kind: 'pricing_error', tier: null, areaId: null, detail: e instanceof Error ? e.message : String(e) }],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The stored quotes' own "Valid until" against when their links stop working (what customers were really sent). */
export function storedValidUntil(e: LiveEstimate, validDays: number): Violation[] {
  const out: Violation[] = [];
  for (const q of e.quotes) {
    if (!q.validUntil || !q.issuedAt) continue;
    const g = liveGolden(e, validDays);
    const draft = sampleDraft({ id: e.id, input: g.input, selectedTier: g.selectedTier, createdAt: q.issuedAt });
    const doc = sampleQuote(draft, { options: [], warnings: [], crewId: '' }, q.issuedAt, validDays);
    for (const v of checkValidUntilIsExpiry({ ...doc, validUntil: q.validUntil }, q.expiresAt)) out.push({ ...v, detail: `quote v${q.version}: ${v.detail}` });
  }
  return out;
}

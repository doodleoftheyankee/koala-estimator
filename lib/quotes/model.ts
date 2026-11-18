// The customer-facing quote document. Built once at send time, frozen into quotes.snapshot,
// and rendered by both the PDF and the public signing page. Contains no costs or margins.
import type { Financing, PricedOption, Tier } from '@/lib/pricing';
import type { EstimateDraft } from '@/lib/sync/draft';

export interface Branding {
  company: string;
  license: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  primaryColor: string; // hex
  logoUrl: string | null;
}

export interface QuoteOptionDoc {
  tier: Tier;
  label: string;
  bullets: string[];
  items: Array<{ areaName: string; description: string; price: number }>;
  price: number;
  financing: Financing | null;
}

export interface QuoteDocument {
  quoteNumber: string; // e.g. KN-2026-1A2B3C-v1
  version: number;
  issuedAt: string; // ISO
  validUntil: string; // ISO date
  branding: Branding;
  customer: { name: string; email: string | null; phone: string | null };
  property: { line1: string; line2: string };
  estimator: { name: string; email: string | null };
  options: QuoteOptionDoc[];
  recommendedTier: Tier | null;
  notes: string | null;
  terms: string;
  warranty: string;
  /** The store's time zone: every date on the quote is a date there. */
  timeZone: string;
}

export const DEFAULT_BRAND_COLOR = '#0f766e';

export function quoteNumber(estimateId: string, version: number, issuedAt: Date): string {
  return `KN-${issuedAt.getUTCFullYear()}-${estimateId.replace(/-/g, '').slice(0, 6).toUpperCase()}-v${version}`;
}

export function buildQuoteDocument(args: {
  draft: EstimateDraft;
  options: PricedOption[];
  version: number;
  issuedAt: Date;
  validDays: number;
  branding: Branding;
  estimator: { name: string; email: string | null };
  terms: string;
  warranty: string;
  timeZone: string;
}): QuoteDocument {
  const { draft, issuedAt } = args;
  const valid = new Date(issuedAt.getTime() + args.validDays * 86_400_000);
  return {
    quoteNumber: quoteNumber(draft.id, args.version, issuedAt),
    version: args.version,
    issuedAt: issuedAt.toISOString(),
    validUntil: valid.toISOString().slice(0, 10),
    branding: args.branding,
    customer: {
      name: `${draft.customer.firstName} ${draft.customer.lastName}`.trim(),
      email: draft.customer.email || null,
      phone: draft.customer.phone || null,
    },
    property: {
      line1: draft.property.street,
      // "Newark, DE 19711"; blank parts are left out rather than printed as stray commas.
      line2: [draft.property.city.trim(), [draft.property.state.trim(), draft.property.zip.trim()].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    },
    estimator: args.estimator,
    options: args.options.map((o) => ({
      tier: o.tier,
      label: o.label,
      bullets: o.bullets,
      items: o.customerItems.map((i) => ({ areaName: i.areaName, description: i.description, price: i.price })),
      price: o.price,
      financing: o.financing,
    })),
    recommendedTier: draft.selectedTier ?? (args.options.some((o) => o.tier === 'better') ? 'better' : null),
    notes: draft.notes?.trim() || null,
    terms: args.terms,
    warranty: args.warranty,
    timeZone: args.timeZone,
  };
}

/** A frozen quote document; documents frozen before stores existed take their store's time zone. */
export function withTimeZone(doc: Omit<QuoteDocument, 'timeZone'> & { timeZone?: string }, storeTimeZone: string): QuoteDocument {
  return { ...doc, timeZone: doc.timeZone || storeTimeZone };
}

export function formatUsd(n: number, cents = false): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

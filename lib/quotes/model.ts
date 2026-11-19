// The customer-facing quote document. Built once at send time, frozen into quotes.snapshot,
// and rendered by both the PDF and the public signing page. Contains no costs or margins.
//
// A document is a snapshot (hard rule 1): once sent, its items, prices, number, dates and consent
// text never change, and it keeps printing the way it was printed when it was sent. `format` says
// how: documents sent before the accuracy round (Nov 2026) have none and print exactly as they did;
// format 2 prints every price in whole dollars, sentences included (OD4).
import { businessDate, formatMoney } from '@/lib/format';
import { recommendedTier } from '@/lib/field/recommended';
import type { CustomerItemKind, Financing, PricedOption, Tier } from '@/lib/pricing';
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
  /**
   * Whole dollars that add up to `price`. kind says what a line is (work, travel, minimum,
   * adjustment); quotes sent before it existed have none, and every line there is work.
   * Job-level lines have areaName ''.
   */
  items: Array<{ kind?: CustomerItemKind; areaName: string; description: string; price: number }>;
  price: number;
  financing: Financing | null;
}

export interface QuoteDocument {
  /**
   * How the document prints (see the top of this file): DOCUMENT_FORMAT for documents sent from
   * the accuracy round on; absent on documents sent before, which print as they always did.
   */
  format?: number;
  /** e.g. KN-2026-0001-v1 (from the counter, OD10); documents sent before: KN-2026-1A2B3C-v1. */
  quoteNumber: string;
  version: number;
  issuedAt: string; // ISO
  /**
   * The business-zone date of the last moment the link works (OD11), YYYY-MM-DD. Documents sent
   * before the accuracy round carry the UTC date instead, which can be a day late; it is kept.
   */
  validUntil: string;
  branding: Branding;
  customer: { name: string; email: string | null; phone: string | null };
  property: { line1: string; line2: string };
  estimator: { name: string; email: string | null };
  options: QuoteOptionDoc[];
  recommendedTier: Tier | null;
  notes: string | null;
  terms: string;
  warranty: string;
  /**
   * The e-sign consent sentence shown beside the signature box, as it was when the quote was sent
   * (lib/quotes/consent.ts). Documents sent before have none: they keep the sentence they were
   * sent with (consentFor).
   */
  consent?: string;
}

export const DEFAULT_BRAND_COLOR = '#0f766e';

/** The document format this code writes (see QuoteDocument.format). */
export const DOCUMENT_FORMAT = 2;

/** True for a document sent before the accuracy round: it prints exactly as it did then (hard rule 1). */
export function isLegacyDocument(doc: Pick<QuoteDocument, 'format'>): boolean {
  return (doc.format ?? 1) < DOCUMENT_FORMAT;
}

// ---------------------------------------------------------------------------
// Money on a quote (one formatter: lib/format.ts formatMoney)
// ---------------------------------------------------------------------------

/** A price on a quote: whole dollars, "$4,780" (OD4). Option totals, items, lists and subjects. */
export const quoteMoney = (n: number): string => formatMoney(n, { cents: 'never' });

/**
 * A price inside a sentence: "You are accepting … for $4,780", "Price: $4,780" (accept sentence,
 * thank-you page, signed PDF, signed emails). Whole dollars (OD4, L8). A document sent before the
 * accuracy round printed cents there ("$4,780.00") and still does (hard rule 1).
 */
export function sentenceMoney(doc: Pick<QuoteDocument, 'format'>, n: number): string {
  return formatMoney(n, { cents: isLegacyDocument(doc) ? 'always' : 'never' });
}

// ---------------------------------------------------------------------------
// Quote numbers (OD10)
// ---------------------------------------------------------------------------

/**
 * The number quotes were given before the counter: KN, the UTC year and six characters of the
 * estimate id ("KN-2026-1A2B3C-v1"). Documents sent then keep it; the phone's list still shows
 * and finds it for them (lib/field/estimateList.ts).
 */
export function legacyQuoteNumber(estimateId: string, version: number, issuedAt: Date): string {
  return `KN-${issuedAt.getUTCFullYear()}-${estimateId.replace(/-/g, '').slice(0, 6).toUpperCase()}-v${version}`;
}

/** The year of an instant in the business time zone (a quote sent Jan 1 at 03:00 UTC is still last year's in New York). */
export function businessYear(at: Date): number {
  return Number(businessDate(at)!.slice(0, 4));
}

/** A quote number from the counter (OD10): prefix, business year, the year's count and the version: "KN-2026-0001-v1". */
export function counterQuoteNumber(prefix: string, year: number, counter: number, version: number): string {
  return `${prefix}-${year}-${String(counter).padStart(4, '0')}-v${version}`;
}

/** A quote number without its version ("KN-2026-0001-v2" -> "KN-2026-0001"), so a new version keeps the number. Null when there is no "-v<n>". */
export function quoteNumberBase(quoteNumber: string): string | null {
  const m = /^(.+)-v\d+$/.exec(quoteNumber.trim());
  return m ? m[1]! : null;
}

/** The prefix in front of every quote number: the quote_number_prefix setting, 1 to 6 capitals or digits. */
export const QUOTE_PREFIX_PATTERN = /^[A-Z0-9]{1,6}$/;

/** The prefix when the setting is missing or not one (OD16: the one quotes already carry). */
export const DEFAULT_QUOTE_PREFIX = 'KN';

// ---------------------------------------------------------------------------
// Validity (OD11)
// ---------------------------------------------------------------------------

/**
 * When a quote's link stops working (issued + validDays x 24 h, stored as quotes.expires_at; the
 * link works up to and including that moment) and the "Valid until" date to print: the
 * business-zone date of that last moment. Sent 2026-11-18 at 02:30 UTC for 30 days: the link
 * stops at 2026-12-18 02:30 UTC, which is Dec 17 at 9:30 PM in the business zone, so Dec 17.
 */
export function quoteValidUntil(issuedAt: Date, validDays: number): { expiresAt: Date; validUntil: string } {
  const expiresAt = new Date(issuedAt.getTime() + validDays * 86_400_000);
  return { expiresAt, validUntil: businessDate(expiresAt)! };
}

export function buildQuoteDocument(args: {
  draft: EstimateDraft;
  options: PricedOption[];
  version: number;
  /** From the counter (counterQuoteNumber), or the earlier version's number with this version. */
  quoteNumber: string;
  issuedAt: Date;
  validDays: number;
  branding: Branding;
  estimator: { name: string; email: string | null };
  terms: string;
  warranty: string;
  /** The e-sign consent sentence for this quote (lib/quotes/consent.ts esignConsent). */
  consent: string;
}): QuoteDocument {
  const { draft, issuedAt } = args;
  return {
    format: DOCUMENT_FORMAT,
    quoteNumber: args.quoteNumber,
    version: args.version,
    issuedAt: issuedAt.toISOString(),
    validUntil: quoteValidUntil(issuedAt, args.validDays).validUntil,
    branding: args.branding,
    customer: {
      name: `${draft.customer.firstName} ${draft.customer.lastName}`.trim(),
      email: draft.customer.email || null,
      phone: draft.customer.phone || null,
    },
    property: {
      line1: draft.property.street,
      line2: `${draft.property.city}, ${draft.property.state} ${draft.property.zip}`,
    },
    estimator: args.estimator,
    options: args.options.map((o) => ({
      tier: o.tier,
      label: o.label,
      bullets: o.bullets,
      items: o.customerItems.map((i) => ({ kind: i.kind, areaName: i.areaName, description: i.description, price: i.price })),
      price: o.price,
      financing: o.financing,
    })),
    // Only an option the quote carries can be recommended (OD1): the estimator's pick, with no pick
    // Better (OD15); when that one is not shown (OD6), the option shown doing the same work, else the
    // nearest shown above it, else the nearest below (lib/field/recommended.ts).
    recommendedTier: recommendedTier(args.options, draft.selectedTier)?.tier ?? null,
    notes: draft.notes?.trim() || null,
    terms: args.terms,
    warranty: args.warranty,
    consent: args.consent,
  };
}

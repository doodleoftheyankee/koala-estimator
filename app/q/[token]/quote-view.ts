// Pure helpers for the customer quote pages: names, links and figures, all derived from the quote
// document or the franchise settings. Nothing here computes a price; every figure is formatted
// from a value the pricing engine already put in the quote. Tested in lib/quotes/quote-page.test.ts.
import type { Financing, Tier } from '@/lib/pricing';
import { calendarDay, formatDate, formatDateLong, formatDateTime, formatMoney, TIER_LABELS } from '@/lib/format';
import { isLegacyDocument, quoteMoney, type Branding, type QuoteDocument, type QuoteOptionDoc } from '@/lib/quotes/model';

export const tierName = (tier: Tier): string => TIER_LABELS[tier];

/** Whole dollars, as every price on a quote shows ("$5,060"; OD4): option cards, items, the PDF. */
export const price = quoteMoney;

/**
 * Dollars and cents ("for $5,060.00"): how the legal sentences of a quote sent before the
 * accuracy round read, and still read (hard rule 1). New quotes print whole dollars there (L8).
 */
export const priceExact = (n: number): string => formatMoney(n, { cents: 'always' });

/** "Dec 18, 2026" (tiles). Date-only values ("2026-12-18") are read as that day. */
export const shortDate = (iso: string): string => formatDate(calendarDay(iso));
/** "December 18, 2026" (sentences). */
export const longDate = (iso: string): string => formatDateLong(calendarDay(iso));

/**
 * When an expired quote's link stopped working, for its page (L13, OD11): the real date and time in
 * the business zone ("Dec 17, 2026 · 9:30 PM"). A quote sent before the accuracy round said its
 * printed "Valid until" date there and still does (hard rule 1).
 */
export const expiredOn = (doc: Pick<QuoteDocument, 'format' | 'validUntil'>, expiresAt: string): string =>
  isLegacyDocument(doc) ? longDate(doc.validUntil) : formatDateTime(expiresAt);

/** A tel: link for a phone number as the franchise typed it. */
export const telHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, '')}`;

/** A web link for the franchise's website as typed ("example.com" or "https://example.com"). */
export const webHref = (site: string): string => (/^https?:\/\//i.test(site) ? site : `https://${site}`);

/** Up to two initials for a person's name tile ("Eddie Estimator" -> "EE"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** The licence line under the franchise name, from its settings ("License 2009-0001"). */
export const licenseLine = (b: Pick<Branding, 'license'>): string | null => (b.license ? `License ${b.license}` : null);

/**
 * The monthly figure the quote's financing line already states ("As low as $102/mo …"), for the
 * gauge beside the price. The same rounding as lib/quotes/email.ts financingLine (up to the
 * dollar); a test keeps the two in step. Only shown when the quote carries financing.
 */
export const monthlyFigure = (f: Pick<Financing, 'monthly'>): string => formatMoney(Math.ceil(f.monthly), { cents: 'never' });

/** What the option cards and the sign bar need about one option. Built on the server. */
export interface QuoteOptionView {
  tier: Tier;
  label: string;
  bullets: string[];
  /** The quote's lines; job-level ones (travel, minimum, adjustment) have no area name. */
  items: QuoteOptionDoc['items'];
  price: number;
  /** Present only when the quote carries financing for this option. */
  financing: { monthly: string; termMonths: number; line: string } | null;
}

// Pure helpers for the customer quote pages: names, links and figures, all derived from the quote
// document or the franchise settings. Nothing here computes a price; every figure is formatted
// from a value the pricing engine already put in the quote. Tested in lib/quotes/quote-page.test.ts.
import type { Financing, Tier } from '@/lib/pricing';
import { formatDate, formatDateLong, formatMoney, TIER_LABELS } from '@/lib/format';
import type { Branding } from '@/lib/quotes/model';

export const tierName = (tier: Tier): string => TIER_LABELS[tier];

/** Whole dollars, as the quote's option cards and its PDF show them ("$5,060"). */
export const price = (n: number): string => formatMoney(n, { cents: 'never' });

/** Dollars and cents, for the legal sentences ("for $5,060.00"). */
export const priceExact = (n: number): string => formatMoney(n, { cents: 'always' });

/** A quote date. Date-only values ("2026-12-18") are read at noon UTC so the day never shifts. */
function quoteDay(iso: string): string {
  return iso.length === 10 ? `${iso}T12:00:00Z` : iso;
}
/** "Dec 18, 2026" (tiles). */
export const shortDate = (iso: string): string => formatDate(quoteDay(iso));
/** "December 18, 2026" (sentences). */
export const longDate = (iso: string): string => formatDateLong(quoteDay(iso));

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
  items: Array<{ areaName: string; description: string; price: number }>;
  price: number;
  /** Present only when the quote carries financing for this option. */
  financing: { monthly: string; termMonths: number; line: string } | null;
}

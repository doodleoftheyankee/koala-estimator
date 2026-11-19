// One formatter module: how money, numbers, units, dates and times read everywhere in the app.
// Formatting only. Nothing here rounds a value that a caller then stores or calculates with, and
// the existing helpers (usd, pct, num, timeAgo) keep their exact output.
//
// Locale and time zone live here and nowhere else, so a franchise setting can replace them later.
// Every date and time a person reads is in BUSINESS_TIME_ZONE, whatever the zone of the server or
// the phone.

export const LOCALE = 'en-US';
/** The business time zone. Replace with the franchise's zone once that setting exists. */
export const BUSINESS_TIME_ZONE = 'America/New_York';

/** Shown for a missing or invalid value. */
export const DASH = '—';

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

// Newer ICU puts a narrow no-break space before AM/PM; plain spaces keep output stable everywhere.
const clean = (s: string) => s.replace(/[  ]/g, ' ');

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const usd0 = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0Signed = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0, signDisplay: 'exceptZero' });
const usd2Signed = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });

export interface MoneyOptions {
  /**
   * auto (default): whole dollars when the amount is a whole number of dollars, otherwise cents
   * ("$4,780", "$4,321.50"; never "$4,321.5"). always: cents every time (legal text, payments).
   * never: whole dollars, rounded (the same as usd()).
   */
  cents?: 'auto' | 'always' | 'never';
  /** Show + for a positive amount: "+$1,430" (differences such as "Compared with Good"). */
  sign?: boolean;
}

/** True when an amount shows as whole dollars at cent precision (4780, 4780.001). */
export function isWholeDollars(n: number): boolean {
  return Math.round(n * 100) % 100 === 0;
}

/** Money for screens: "$4,780", "$4,321.50", "+$1,430". "—" when missing. (Not lib/pricing money(), which rounds a value to cents.) */
export function formatMoney(n: number | null | undefined, opts: MoneyOptions = {}): string {
  if (!finite(n)) return DASH;
  const mode = opts.cents ?? 'auto';
  const withCents = mode === 'always' || (mode === 'auto' && !isWholeDollars(n));
  if (opts.sign) return (withCents ? usd2Signed : usd0Signed).format(n);
  return (withCents ? usd2 : usd0).format(n);
}

/** Dollars, whole by default (rounded) or always with cents. Kept for existing screens. */
export const usd = (n: number, cents = false) => (cents ? usd2 : usd0).format(n);

// ---------------------------------------------------------------------------
// Numbers and percents
// ---------------------------------------------------------------------------

/** A plain number with thousands separators and at most `digits` decimals: "1,234.6". */
export const num = (n: number, digits = 0) => n.toLocaleString(LOCALE, { maximumFractionDigits: digits });

/** A ratio as a percent with fixed decimals: pct(0.4005) = "40.1%". */
export const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

/** A ratio as a percent, optionally signed: percent(0.12, { digits: 0, sign: true }) = "+12%". */
export function percent(ratio: number | null | undefined, opts: { digits?: number; sign?: boolean } = {}): string {
  if (!finite(ratio)) return DASH;
  const s = pct(ratio, opts.digits ?? 1);
  return opts.sign && ratio * 100 > 0 && !/^0\.?0*%$/.test(s) ? `+${s}` : s;
}

/** "1 face", "3 faces", "2 people" (pass the plural when it isn't singular + "s"). */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${num(n)} ${n === 1 ? singular : pluralForm}`;
}

// ---------------------------------------------------------------------------
// Units (one vocabulary: sq ft, ft, in, R-, rise/12, person-hours)
// ---------------------------------------------------------------------------

/** Area: "1,970 sq ft". */
export const sqft = (n: number | null | undefined, digits = 0) => (finite(n) ? `${num(n, digits)} sq ft` : DASH);
/** Length in feet: "204 ft". */
export const feet = (n: number | null | undefined, digits = 0) => (finite(n) ? `${num(n, digits)} ft` : DASH);
/** Inches: "12 in", "3.5 in". */
export const inches = (n: number | null | undefined, digits = 1) => (finite(n) ? `${num(n, digits)} in` : DASH);
/** An R-value: "R-60", "R-13.5". */
export const rValue = (n: number | null | undefined) => (finite(n) ? `R-${n.toLocaleString(LOCALE, { maximumFractionDigits: 1, useGrouping: false })}` : DASH);
/** Roof pitch as rise over 12: pitch(6) = "6/12". Pass the rise already rounded the way you show it. */
export const pitch = (rise: number | null | undefined) => (finite(rise) ? `${rise.toLocaleString(LOCALE, { maximumFractionDigits: 2, useGrouping: false })}/12` : DASH);
/** Labour: "12.5 person-hours", or "12.5 p-h" in tables. */
export const personHours = (n: number | null | undefined, opts: { short?: boolean; digits?: number } = {}) =>
  finite(n) ? `${num(n, opts.digits ?? 1)} ${opts.short ? 'p-h' : n === 1 ? 'person-hour' : 'person-hours'}` : DASH;

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * A phone number for reading. North American numbers, however they were typed or stored
 * ("+13025550007", "302.555.0007"), read "(302) 555-0007"; anything else (an extension, another
 * country) shows as typed. Links keep using the digits (tel:).
 */
export function formatPhone(raw: string | null | undefined): string {
  const typed = raw?.trim() ?? '';
  if (!typed) return DASH;
  if (/[a-z]/i.test(typed)) return typed;
  const digits = typed.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length === 10 && !typed.startsWith('+') ? digits : null;
  return national ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : typed;
}

// ---------------------------------------------------------------------------
// Dates and times, always in BUSINESS_TIME_ZONE
// ---------------------------------------------------------------------------

export type DateInput = Date | string | number | null | undefined;

function toDate(at: DateInput): Date | null {
  if (at === null || at === undefined || at === '') return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d : null;
}

const fmtDate = new Intl.DateTimeFormat(LOCALE, { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric' });
const fmtDateLong = new Intl.DateTimeFormat(LOCALE, { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric' });
const fmtDayMonth = new Intl.DateTimeFormat(LOCALE, { timeZone: BUSINESS_TIME_ZONE, month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(LOCALE, { timeZone: BUSINESS_TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const fmtYmd = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtAudit = new Intl.DateTimeFormat(LOCALE, {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/**
 * A value that is either an instant or a calendar day stored without a time ("2026-12-17", such as
 * a quote's "Valid until"). A calendar day is read at noon UTC, so it formats as that same day in
 * any business zone; pass it through this before formatting. Instants are unchanged.
 */
export function calendarDay(at: DateInput): DateInput {
  return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T12:00:00Z` : at;
}

/** "Nov 17, 2026". */
export function formatDate(at: DateInput): string {
  const d = toDate(at);
  return d ? clean(fmtDate.format(d)) : DASH;
}

/** "November 17, 2026" (customer documents). */
export function formatDateLong(at: DateInput): string {
  const d = toDate(at);
  return d ? clean(fmtDateLong.format(d)) : DASH;
}

/** "Nov 17" (this year's dates in a list). */
export function formatDayMonth(at: DateInput): string {
  const d = toDate(at);
  return d ? clean(fmtDayMonth.format(d)) : DASH;
}

/** "7:41 PM". */
export function formatTime(at: DateInput): string {
  const d = toDate(at);
  return d ? clean(fmtTime.format(d)) : DASH;
}

/** "Nov 17, 2026 · 7:41 PM": the one full date-and-time style. */
export function formatDateTime(at: DateInput): string {
  const d = toDate(at);
  return d ? `${clean(fmtDate.format(d))} · ${clean(fmtTime.format(d))}` : DASH;
}

/** "Nov 17 · 7:41 PM" (lists, where the year is clear). */
export function formatShortDateTime(at: DateInput): string {
  const d = toDate(at);
  return d ? `${clean(fmtDayMonth.format(d))} · ${clean(fmtTime.format(d))}` : DASH;
}

/** "November 17, 2026 at 7:41:07 PM EST": a signature's moment on a signed quote, to the second and with the zone. */
export function formatAuditTime(at: DateInput): string {
  const d = toDate(at);
  return d ? fmtAudit.format(d) : DASH;
}

/** The business-zone calendar date of an instant, YYYY-MM-DD. */
export function businessDate(at: DateInput): string | null {
  const d = toDate(at);
  return d ? fmtYmd.format(d) : null;
}

/**
 * Relative time for lists ("just now", "15 min ago", "3 h ago", "yesterday", "5 days ago").
 * Show the full date (formatDateTime) on tap or hover.
 */
export function relativeTime(at: DateInput, now: number = Date.now()): string {
  const d = toDate(at);
  if (!d) return DASH;
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Relative time from an ISO string. Kept for existing screens; same as relativeTime. */
export function timeAgo(iso: string, now = Date.now()): string {
  return relativeTime(iso, now);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const JOB_TYPE_LABELS = {
  attic: 'Attic',
  walls: 'Walls',
  crawlspace: 'Crawlspace',
  rim_joist: 'Rim joist',
  garage: 'Garage',
  commercial: 'Commercial',
} as const;

export const ACCESS_LABELS = { easy: 'Easy', moderate: 'Moderate', difficult: 'Difficult', extreme: 'Extreme' } as const;

export const ACCESS_HINTS = {
  easy: 'Walk-up or pull-down stairs, 4 ft+ clearance',
  moderate: 'Scuttle hatch, 3–4 ft clearance, some obstructions',
  difficult: 'Under 3 ft clearance, heavy obstructions, long hose runs',
  extreme: 'Crawl-only, confined space, many small bays',
} as const;

export const TIER_LABELS = { good: 'Good', better: 'Better', best: 'Best' } as const;

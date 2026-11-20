// What the settings say about the business beyond the branding (lib/quotes/settings.ts): the town a
// new estimate starts in, the state the e-sign sentence names and the prefix of quote numbers. None
// of it is typed in the code (hard rule 3), and none of it is required: there is no business form to
// fill in, and nothing blocks or delays a send (owner decision OD12). A detail nobody entered is
// simply left off the quote. Pure, so the send route, the bundle (for the phone) and the optional
// Business profile page share it.
import { esignConsent, stateName } from './consent';
import { DEFAULT_QUOTE_PREFIX, QUOTE_PREFIX_PATTERN } from './model';
import { quoteSettingsFromRows, type QuoteSettings } from './settings';

/** A field of the optional Business profile page (app/admin/business). */
export interface ProfileField {
  /** The app_settings key, or "branding.<field>" for a field of the branding setting. */
  key: string;
  label: string;
  hint?: string;
}

/** The fields of the optional Business profile page, in the order the page shows them. */
export const PROFILE_FIELDS: readonly ProfileField[] = [
  { key: 'branding.company', label: 'Company name', hint: 'As customers see it on every quote, email and PDF. Left as it is, quotes say Koala Insulation.' },
  { key: 'branding.license', label: 'License number', hint: 'Optional. Printed under the company name; left empty, quotes leave it off.' },
  { key: 'branding.phone', label: 'Office phone', hint: 'Optional. Left empty, customers are pointed to their estimator.' },
  { key: 'branding.email', label: 'Office email', hint: 'Optional.' },
  { key: 'branding.website', label: 'Website', hint: 'Optional.' },
  { key: 'quote_number_prefix', label: 'Quote number prefix', hint: '1 to 6 capital letters or digits: quote numbers read PREFIX-2026-0001-v1.' },
  { key: 'warranty_text', label: 'Warranty', hint: 'Printed on every quote and its PDF.' },
  { key: 'quote_terms', label: 'Terms', hint: 'Printed on every quote and its PDF.' },
];

export type SettingRow = { key: string; value: unknown };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** A setting's value as text ('' when it is not set). "branding.phone" reads a field of the branding setting. */
export function profileValue(rows: readonly SettingRow[], key: string): string {
  const [setting, field] = key.split('.', 2) as [string, string | undefined];
  const value = rows.find((r) => r.key === setting)?.value;
  if (field === undefined) return text(value);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? text((value as Record<string, unknown>)[field]) : '';
}

/**
 * The town and state in an address such as "Newark, DE 19711" or "1 Main St, Springfield, IL",
 * or null when it does not end in a town and a state.
 */
export function townOf(address: string): { city: string; state: string } | null {
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p, i, all) => !(i === all.length - 1 && /^(usa|us|united states)$/i.test(p)));
  if (parts.length < 2) return null;
  const m = /^([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(parts[parts.length - 1]!);
  const city = parts[parts.length - 2]!;
  if (!m || !stateName(m[1]) || /\d/.test(city)) return null;
  return { city, state: m[1]!.toUpperCase() };
}

/**
 * Where a new estimate starts (OD14, review A DOC-2): the town and state of the shop address (the
 * Pricing page's "Shop address") as a pair when it reads as one, else both blank. A town from one
 * place is never paired with a state from another.
 */
export function newEstimateDefaults(rows: readonly SettingRow[]): { city: string; state: string } {
  return townOf(profileValue(rows, 'shop_address')) ?? { city: '', state: '' };
}

/**
 * The state a new quote's e-sign sentence names (OD14): the property's when it is a real US state,
 * else the shop address's, else null (the sentence then names no state: lib/quotes/consent.ts).
 */
export function consentState(rows: readonly SettingRow[], propertyState: string | null | undefined): string | null {
  const own = (propertyState ?? '').trim().toUpperCase();
  if (stateName(own)) return own;
  return townOf(profileValue(rows, 'shop_address'))?.state ?? null;
}

/** The prefix of new quote numbers: the stored one when it is 1 to 6 capitals or digits, else KN (OD16). */
export function quotePrefix(rows: readonly SettingRow[]): string {
  const stored = profileValue(rows, 'quote_number_prefix');
  return QUOTE_PREFIX_PATTERN.test(stored) ? stored : DEFAULT_QUOTE_PREFIX;
}

/**
 * Everything the send route takes from the settings for a new quote: what it prints, its number's
 * prefix and its consent sentence. Never throws and never refuses (OD12): whatever is not filled in
 * prints its default or is left off.
 */
export function quoteSettingsForSend(rows: readonly SettingRow[], propertyState: string | null | undefined): { settings: QuoteSettings; prefix: string; consent: string } {
  return { settings: quoteSettingsFromRows([...rows]), prefix: quotePrefix(rows), consent: esignConsent(consentState(rows, propertyState)) };
}

/** What the phone needs to know, carried with the pricing bundle (outside its hash). */
export interface BusinessInfo {
  /** Where a new estimate starts. */
  newEstimate: { city: string; state: string };
}

export function businessInfo(rows: readonly SettingRow[]): BusinessInfo {
  return { newEstimate: newEstimateDefaults(rows) };
}

// The business profile: what every quote prints about the franchise (name, license, phone,
// warranty, terms), the state its e-sign sentence names, the town new estimates start in and the
// prefix of its quote numbers. All of it is app_settings rows, filled in on /admin/business; none
// of it is typed in the code (hard rule 3).
//
// A quote cannot be sent while the profile has a gap (L30): a required field that is empty or
// still says PLACEHOLDER, so "PLACEHOLDER" and a missing phone or license never reach a customer.
// Pure, so the send route, the bundle (for the phone's checklist) and the page share it.
import { stateName } from './consent';
import { QUOTE_PREFIX_PATTERN } from './model';

export interface ProfileField {
  /** The app_settings key, or "branding.<field>" for a field of the branding setting. */
  key: string;
  label: string;
  /** A quote cannot be sent while a required field is missing. */
  required: boolean;
  /** How the gap reads in a sentence ("the office phone"). */
  missing: string;
  hint?: string;
}

/** Every field of the profile, in the order the page shows them. */
export const PROFILE_FIELDS: readonly ProfileField[] = [
  { key: 'branding.company', label: 'Company name', required: true, missing: 'the company name', hint: 'As customers see it on every quote, email and PDF.' },
  { key: 'branding.license', label: 'License number', required: true, missing: 'the license number', hint: 'Printed under the company name.' },
  { key: 'branding.phone', label: 'Office phone', required: true, missing: 'the office phone', hint: 'Customers are told to call it about a quote.' },
  { key: 'branding.email', label: 'Office email', required: false, missing: 'the office email' },
  { key: 'branding.website', label: 'Website', required: false, missing: 'the website' },
  { key: 'default_city', label: 'Town', required: false, missing: 'the town', hint: 'New estimates start in this town. Left empty, they take the town of the shop address.' },
  {
    key: 'default_state',
    label: 'State',
    required: true,
    missing: 'the state',
    hint: 'Two letters, such as PA. New estimates start in this state, and the signing sentence names its e-sign law.',
  },
  { key: 'quote_number_prefix', label: 'Quote number prefix', required: true, missing: 'the quote number prefix', hint: '1 to 6 capital letters or digits: quote numbers read PREFIX-2026-0001-v1.' },
  { key: 'warranty_text', label: 'Warranty', required: true, missing: 'the warranty', hint: 'Printed on every quote and its PDF.' },
  { key: 'quote_terms', label: 'Terms', required: true, missing: 'the terms', hint: 'Printed on every quote and its PDF.' },
];

export type SettingRow = { key: string; value: unknown };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** A profile field's value as text ('' when it is not set). */
export function profileValue(rows: readonly SettingRow[], key: string): string {
  const [setting, field] = key.split('.', 2) as [string, string | undefined];
  const value = rows.find((r) => r.key === setting)?.value;
  if (field === undefined) return text(value);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? text((value as Record<string, unknown>)[field]) : '';
}

/** True when a field's value is missing, still a seed placeholder, or not a value the field can hold. */
function isGap(field: ProfileField, value: string): boolean {
  if (!value || /placeholder/i.test(value)) return true;
  if (field.key === 'default_state') return stateName(value) === null;
  if (field.key === 'quote_number_prefix') return !QUOTE_PREFIX_PATTERN.test(value);
  return false;
}

/** The required fields a quote still needs, in page order. Empty when a quote can be sent. */
export function businessProfileGaps(rows: readonly SettingRow[]): ProfileField[] {
  return PROFILE_FIELDS.filter((f) => f.required && isGap(f, profileValue(rows, f.key)));
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "The business profile is not finished: add the license number, the office phone and the warranty." */
export function profileGapsSentence(gaps: ReadonlyArray<Pick<ProfileField, 'missing'> | string>): string {
  return `The business profile is not finished: add ${list(gaps.map((g) => (typeof g === 'string' ? g : g.missing)))}.`;
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

/** Where a new estimate starts (L32): the profile's town and state, else the shop address's, else blank. */
export function newEstimateDefaults(rows: readonly SettingRow[]): { city: string; state: string } {
  const shop = townOf(profileValue(rows, 'shop_address'));
  const city = profileValue(rows, 'default_city');
  const state = profileValue(rows, 'default_state').toUpperCase();
  return {
    city: city && !/placeholder/i.test(city) ? city : (shop?.city ?? ''),
    state: stateName(state) ? state : (shop?.state ?? ''),
  };
}

/** What the phone needs to know about the profile, carried with the pricing bundle (outside its hash). */
export interface BusinessInfo {
  /** The gaps, as they read in a sentence ("the office phone"); empty when a quote can be sent. */
  gaps: string[];
  /** Where a new estimate starts. */
  newEstimate: { city: string; state: string };
}

export function businessInfo(rows: readonly SettingRow[]): BusinessInfo {
  return { gaps: businessProfileGaps(rows).map((g) => g.missing), newEstimate: newEstimateDefaults(rows) };
}

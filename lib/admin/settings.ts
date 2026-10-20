// Business settings (app_settings) as the admin UI sees them: labels, input kinds, and the
// parser that turns a submitted form into jsonb values. Pure, so it is unit-tested.
import { z } from 'zod';
import {
  booleanField,
  fractionToPercent,
  issuesMessage,
  numberField,
  optionalTextField,
  percentField,
  textField,
  uuidField,
  type Json,
} from './forms';

export type SettingKind = 'percent' | 'number' | 'integer' | 'money' | 'boolean' | 'text' | 'textarea' | 'crew';

export interface ScalarSetting {
  key: string;
  label: string;
  kind: SettingKind;
  hint?: string;
  /** Input bounds in the units shown (percent for percent settings). */
  min?: number;
  max?: number;
  step?: string;
}

/** Scalar settings, grouped as they appear on the page. */
export const SETTING_GROUPS: ReadonlyArray<{ id: string; title: string; settings: ReadonlyArray<ScalarSetting> }> = [
  {
    id: 'margins',
    title: 'Margins and overhead',
    settings: [
      { key: 'overhead_pct', label: 'Overhead', kind: 'percent', hint: '% of direct cost (0–300%)', min: 0, max: 300 },
      { key: 'target_margin_pct', label: 'Target margin', kind: 'percent', hint: 'Gross margin on price (0–95%)', min: 0, max: 95 },
      { key: 'floor_margin_pct', label: 'Floor margin', kind: 'percent', hint: 'Never below this without owner override', min: 0, max: 95 },
      { key: 'ceiling_margin_pct', label: 'Ceiling margin', kind: 'percent', hint: 'Upper bound for the price optimizer', min: 0, max: 95 },
      { key: 'estimator_override_limit_pct', label: 'Estimator override limit', kind: 'percent', hint: 'Max price change an estimator can make alone', min: 0, max: 100 },
      { key: 'deviation_threshold', label: 'Deviation flag threshold', kind: 'percent', hint: 'Flag estimates this far from the model', min: 0, max: 100 },
    ],
  },
  {
    id: 'operations',
    title: 'Prices and operations',
    settings: [
      { key: 'minimum_job_price', label: 'Minimum job price', kind: 'money', hint: '$ per job', min: 0, step: '1' },
      { key: 'price_rounding', label: 'Price rounding', kind: 'money', hint: 'Round customer prices up to the nearest $', min: 0, step: '1' },
      { key: 'productive_hours_per_day', label: 'Productive hours per day', kind: 'number', hint: 'Per crew member (up to 24)', min: 0, max: 24, step: '0.25' },
      { key: 'vehicle_cost_per_trip', label: 'Vehicle cost per trip', kind: 'money', hint: '$ per crew-day trip (rig, fuel)', min: 0 },
      { key: 'disposal_cost_per_sqft', label: 'Disposal cost per sq ft', kind: 'money', hint: '$ per sq ft of removal', min: 0 },
      { key: 'quote_valid_days', label: 'Quote valid for (days)', kind: 'integer', min: 1, max: 365, step: '1' },
      { key: 'estimators_see_costs', label: 'Estimators see costs and margin', kind: 'boolean' },
      { key: 'default_crew_id', label: 'Default crew', kind: 'crew', hint: 'Used when an estimate does not pick a crew' },
      { key: 'shop_address', label: 'Shop address', kind: 'text', hint: 'Origin for drive-time estimates' },
    ],
  },
  {
    id: 'quote-text',
    title: 'Quote text',
    settings: [
      { key: 'quote_terms', label: 'Quote terms', kind: 'textarea', hint: 'Printed on every quote' },
      { key: 'warranty_text', label: 'Warranty', kind: 'textarea', hint: 'Printed on the quote PDF' },
    ],
  },
];

export const BRANDING_FIELDS = [
  { key: 'company', label: 'Company name', type: 'text' },
  { key: 'license', label: 'License number', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'tel' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'website', label: 'Website', type: 'url' },
  { key: 'primary_color', label: 'Primary color', type: 'text' },
] as const;

/** Readable names, used as the description when a "PLACEHOLDER — ..." description is cleared. */
export const SETTING_LABELS: Record<string, string> = {
  ...Object.fromEntries(SETTING_GROUPS.flatMap((g) => g.settings.map((s) => [s.key, s.label]))),
  financing: 'Financing partner and terms',
  branding: 'Quote PDF branding',
};

// ---------------------------------------------------------------------------
// Per-key validators (form strings -> jsonb value)
// ---------------------------------------------------------------------------

const scalarSchemas: Record<string, z.ZodType<Json>> = {
  overhead_pct: percentField('Overhead', { min: 0, max: 300 }),
  target_margin_pct: percentField('Target margin', { min: 0, lt: 95 }),
  floor_margin_pct: percentField('Floor margin', { min: 0, max: 95 }),
  ceiling_margin_pct: percentField('Ceiling margin', { min: 0, max: 95 }),
  estimator_override_limit_pct: percentField('Estimator override limit', { min: 0, max: 100 }),
  deviation_threshold: percentField('Deviation threshold', { gt: 0, max: 100 }),
  minimum_job_price: numberField('Minimum job price', { min: 0, max: 1_000_000 }),
  price_rounding: numberField('Price rounding', { min: 0, max: 10_000 }),
  productive_hours_per_day: numberField('Productive hours per day', { gt: 0, max: 24 }),
  vehicle_cost_per_trip: numberField('Vehicle cost per trip', { min: 0, max: 100_000 }),
  disposal_cost_per_sqft: numberField('Disposal cost per sq ft', { min: 0, max: 1_000 }),
  quote_valid_days: numberField('Quote valid days', { min: 1, max: 365, integer: true }),
  estimators_see_costs: booleanField,
  default_crew_id: uuidField('Default crew'),
  shop_address: textField('Shop address', 300),
  quote_terms: textField('Quote terms', 10_000),
  warranty_text: textField('Warranty', 10_000),
};

const financingSchema = z.object({
  provider: optionalTextField('Financing provider', 100),
  apr: percentField('Financing APR', { min: 0, lt: 100 }),
  term_months: numberField('Financing term', { gt: 0, max: 360, integer: true }),
  show: booleanField,
});

const colorField = optionalTextField('Primary color', 7).pipe(
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Primary color must look like #0f766e')
    .nullable(),
);

const brandingSchema = z.object({
  company: textField('Company name', 200),
  license: optionalTextField('License number', 100),
  phone: optionalTextField('Phone', 50),
  email: optionalTextField('Email', 200).pipe(z.email('Branding email is not a valid email').nullable()),
  website: optionalTextField('Website', 300),
  primary_color: colorField,
});

/** Keys this form can write, in the order they are saved. */
export const EDITABLE_SETTING_KEYS = [...Object.keys(scalarSchemas), 'financing', 'branding'] as const;

function subObject(obj: Record<string, string>, prefix: string): Record<string, string> | null {
  const entries = Object.entries(obj).filter(([k]) => k.startsWith(`${prefix}.`));
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.map(([k, v]) => [k.slice(prefix.length + 1), v]));
}

export type ParsedSettings = { ok: true; values: Record<string, Json> } | { ok: false; error: string };

/**
 * Parses the settings present in a submitted form. Scalar keys are submitted by their
 * own name; financing and branding as "financing.apr", "branding.company", etc. Keys
 * that are not in the form are left out, so each card on the page can save on its own.
 */
export function parseSettingsForm(obj: Record<string, string>): ParsedSettings {
  const values: Record<string, Json> = {};
  const errors: string[] = [];

  for (const [key, schema] of Object.entries(scalarSchemas)) {
    if (!(key in obj)) continue;
    const r = schema.safeParse(obj[key]);
    if (r.success) values[key] = r.data;
    else errors.push(issuesMessage(r.error));
  }

  const fin = subObject(obj, 'financing');
  if (fin) {
    const r = financingSchema.safeParse(fin);
    if (r.success) values.financing = r.data;
    else errors.push(issuesMessage(r.error));
  }

  const brand = subObject(obj, 'branding');
  if (brand) {
    const r = brandingSchema.safeParse(brand);
    if (r.success) values.branding = r.data;
    else errors.push(issuesMessage(r.error));
  }

  if (errors.length) return { ok: false, error: errors.join(' · ') };
  if (Object.keys(values).length === 0) return { ok: false, error: 'Nothing to save.' };
  return { ok: true, values };
}

/**
 * Rules that span several settings and that the pricing engine's own validation does not
 * check. `merged` is the current settings with the new values applied.
 */
export function crossCheckSettings(merged: Record<string, unknown>): string | null {
  const n = (k: string) => Number(merged[k]);
  if (Number.isFinite(n('ceiling_margin_pct')) && Number.isFinite(n('target_margin_pct')) && n('ceiling_margin_pct') < n('target_margin_pct')) {
    return 'Ceiling margin must be at least the target margin.';
  }
  if (Number.isFinite(n('floor_margin_pct')) && Number.isFinite(n('target_margin_pct')) && n('floor_margin_pct') > n('target_margin_pct')) {
    return 'Floor margin must not be above the target margin.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading values for display
// ---------------------------------------------------------------------------

export type SettingsMap = Record<string, unknown>;

export function toSettingsMap(rows: ReadonlyArray<{ key: string; value: unknown }>): SettingsMap {
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** The value to put in an input's defaultValue (percent settings shown as percentages). */
export function displayValue(map: SettingsMap, setting: ScalarSetting): string {
  const v = map[setting.key];
  if (v === null || v === undefined) return '';
  if (setting.kind === 'percent') {
    const num = Number(v);
    return Number.isFinite(num) ? String(fractionToPercent(num)) : '';
  }
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return '';
}

export function settingBool(map: SettingsMap, key: string): boolean {
  const v = map[key];
  return v === true || v === 'true';
}

export function settingObject(map: SettingsMap, key: string): Record<string, unknown> {
  const v = map[key];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A field of an object setting as input text ('' for null/missing). */
export function objectFieldText(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

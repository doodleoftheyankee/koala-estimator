// Quote presentation settings (branding, terms, warranty, validity) from app_settings.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DEFAULT_BRAND_COLOR, type Branding } from './model';

// What a quote prints when a setting is not filled in (OD12, OD13): the brand, terms that name no
// town, and the warranty the owner gave. The accuracy migration writes the same words over the seeds
// (supabase/migrations/20261119000001_accuracy.sql, "owner decisions OD12 and OD13").
export const DEFAULT_COMPANY = 'Koala Insulation';
export const DEFAULT_VALID_DAYS = 30;
export const DEFAULT_TERMS =
  'Quote valid for the period shown. A signed quote authorizes Koala Insulation to schedule the work. ' +
  'Final price may change only if hidden conditions are found; any change requires your written approval.';
export const DEFAULT_WARRANTY = 'Limited lifetime warranty';

export interface QuoteSettings {
  branding: Branding;
  terms: string;
  warranty: string;
  validDays: number;
}

/**
 * A stored text a quote can print: trimmed, and not empty. Anything that still says PLACEHOLDER (a
 * seed nobody replaced, or one typed in) counts as not filled in, so the default is printed or the
 * detail is left off (OD12): a customer never reads "PLACEHOLDER".
 */
function toText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && !/placeholder/i.test(v) ? v.trim() : null;
}

const optText = z
  .unknown()
  .transform(toText)
  .catch(null);

const brandingSchema = z
  .object({
    company: optText,
    license: optText,
    phone: optText,
    email: optText,
    website: optText,
    primary_color: optText,
    logo_path: optText,
  })
  .partial()
  .catch({});

const HEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

/** Pure mapping from app_settings rows; exported for tests. */
export function quoteSettingsFromRows(rows: Array<{ key: string; value: unknown }>): QuoteSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const b = brandingSchema.parse(map.get('branding') ?? {});
  const color = b.primary_color && HEX.test(b.primary_color) ? b.primary_color : DEFAULT_BRAND_COLOR;
  // Only absolute https URLs are usable as a logo (the PDF fetches it at render time).
  const logoUrl = b.logo_path && /^https:\/\//.test(b.logo_path) ? b.logo_path : null;

  const rawDays = Number(map.get('quote_valid_days'));
  const validDays = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.round(rawDays) : DEFAULT_VALID_DAYS;

  return {
    branding: {
      company: b.company ?? DEFAULT_COMPANY,
      license: b.license ?? null,
      phone: b.phone ?? null,
      email: b.email ?? null,
      website: b.website ?? null,
      primaryColor: color,
      logoUrl,
    },
    terms: toText(map.get('quote_terms')) ?? DEFAULT_TERMS,
    warranty: toText(map.get('warranty_text')) ?? DEFAULT_WARRANTY,
    validDays,
  };
}

export async function loadQuoteSettings(supabase: SupabaseClient): Promise<QuoteSettings> {
  return quoteSettingsFromRows(await loadQuoteSettingRows(supabase));
}

/**
 * Every setting a quote is built from: what quoteSettingsFromRows reads, and what lib/quotes/profile.ts
 * reads (the quote number prefix, and the shop address for new estimates' town and the consent state).
 */
export const QUOTE_SETTING_KEYS = ['branding', 'quote_terms', 'warranty_text', 'quote_valid_days', 'quote_number_prefix', 'shop_address'] as const;

export async function loadQuoteSettingRows(supabase: SupabaseClient): Promise<Array<{ key: string; value: unknown }>> {
  const { data, error } = await supabase.from('app_settings').select('key, value').in('key', [...QUOTE_SETTING_KEYS]);
  if (error) throw new Error(`Loading quote settings failed: ${error.message}`);
  return (data ?? []) as Array<{ key: string; value: unknown }>;
}

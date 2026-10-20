// Quote presentation settings (branding, terms, warranty, validity) from app_settings.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DEFAULT_BRAND_COLOR, type Branding } from './model';

export const DEFAULT_COMPANY = 'Koala Insulation of Newark';
export const DEFAULT_VALID_DAYS = 30;
export const DEFAULT_TERMS =
  'Quote valid for the period shown. A signed quote authorizes Koala Insulation of Newark to schedule the work. ' +
  'Final price may change only if hidden conditions are found; any change requires your written approval.';
export const DEFAULT_WARRANTY = 'Workmanship warranty details are available from our office.';

export interface QuoteSettings {
  branding: Branding;
  terms: string;
  warranty: string;
  validDays: number;
}

const optText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
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

function toText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

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
  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['branding', 'quote_terms', 'warranty_text', 'quote_valid_days']);
  if (error) throw new Error(`Loading quote settings failed: ${error.message}`);
  return quoteSettingsFromRows((data ?? []) as Array<{ key: string; value: unknown }>);
}

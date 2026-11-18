// Quote presentation settings (branding, terms, warranty, validity). The company name, license,
// phone, color and logo are the store's (locations); email, website, terms, warranty and validity
// are the store's app_settings.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { LocationInfo } from '@/lib/locations/location';
import { DEFAULT_BRAND_COLOR, type Branding } from './model';

export const DEFAULT_VALID_DAYS = 30;
export function defaultTerms(company: string): string {
  return (
    `Quote valid for the period shown. A signed quote authorizes ${company} to schedule the work. ` +
    'Final price may change only if hidden conditions are found; any change requires your written approval.'
  );
}
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

/** The store's details that brand a quote. */
export type QuoteLocation = Pick<LocationInfo, 'name' | 'licenseNumber' | 'phone' | 'brandColor' | 'logoPath'>;

/** Pure mapping from the store and its app_settings rows; exported for tests. */
export function quoteSettingsFromRows(rows: Array<{ key: string; value: unknown }>, location: QuoteLocation): QuoteSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const b = brandingSchema.parse(map.get('branding') ?? {});
  const rawColor = location.brandColor ?? b.primary_color;
  const color = rawColor && HEX.test(rawColor) ? rawColor : DEFAULT_BRAND_COLOR;
  // Only absolute https URLs are usable as a logo (the PDF fetches it at render time).
  const rawLogo = location.logoPath ?? b.logo_path;
  const logoUrl = rawLogo && /^https:\/\//.test(rawLogo) ? rawLogo : null;

  const rawDays = Number(map.get('quote_valid_days'));
  const validDays = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.round(rawDays) : DEFAULT_VALID_DAYS;

  return {
    branding: {
      company: location.name,
      license: location.licenseNumber ?? b.license ?? null,
      phone: location.phone ?? b.phone ?? null,
      email: b.email ?? null,
      website: b.website ?? null,
      primaryColor: color,
      logoUrl,
    },
    terms: toText(map.get('quote_terms')) ?? defaultTerms(location.name),
    warranty: toText(map.get('warranty_text')) ?? DEFAULT_WARRANTY,
    validDays,
  };
}

export async function loadQuoteSettings(supabase: SupabaseClient, location: LocationInfo): Promise<QuoteSettings> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value')
    .eq('location_id', location.id)
    .in('key', ['branding', 'quote_terms', 'warranty_text', 'quote_valid_days']);
  if (error) throw new Error(`Loading quote settings failed: ${error.message}`);
  return quoteSettingsFromRows((data ?? []) as Array<{ key: string; value: unknown }>, location);
}

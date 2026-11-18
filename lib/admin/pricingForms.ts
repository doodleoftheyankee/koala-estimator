// Form schemas for the pricing tables edited on /admin/pricing. Pure (zod only).
import { z } from 'zod';
import { JOB_TYPES, PRODUCTS, TIERS } from '@/lib/pricing';
import {
  booleanField,
  issuesMessage,
  linesField,
  numberField,
  optionalNumberField,
  optionalTextField,
  textField,
  uuidField,
} from './forms';
import { isTimeZone } from '@/lib/locations/location';

/** Products that can be the primary (R-bearing) product of a tier. */
export const PRIMARY_PRODUCTS = PRODUCTS.filter((p) => p !== 'air_sealing' && p !== 'removal');

export const materialForm = z.object({
  id: uuidField('Material'),
  name: textField('Material name', 120),
  cost_per_unit: numberField('Cost per unit', { min: 0, max: 100_000 }),
  coverage_sqft_in: optionalNumberField('Coverage', { gt: 0, max: 100_000 }),
});

const crewFields = {
  name: textField('Crew name', 80),
  size: numberField('Crew size', { min: 1, max: 10, integer: true }),
  blended_hourly_cost: numberField('Hourly cost', { min: 0, max: 1_000 }),
};

export const crewForm = z.object({ id: uuidField('Crew'), ...crewFields, active: booleanField });
export const newCrewForm = z.object(crewFields);

export const tierRowForm = z.object({
  id: uuidField('Tier'),
  label: textField('Tier label', 120),
  primary_product: z.enum(PRIMARY_PRODUCTS, { error: 'Pick a primary product' }),
  target_r: optionalNumberField('Target R', { gt: 0, max: 100 }),
  include_air_sealing: booleanField,
  include_removal: booleanField,
  marketing_bullets: linesField('Bullets', 8, 200),
  active: booleanField,
});
export type TierRow = z.infer<typeof tierRowForm>;

export const codeRequirementForm = z.object({
  id: uuidField('Code requirement'),
  min_r: numberField('Minimum R', { gt: 0, max: 100 }),
  alt_spec: optionalTextField('Alternative spec', 60),
  code_edition: textField('Code edition', 60),
  source_note: optionalTextField('Source note', 300),
});

export const productForm = z.object({
  id: uuidField('Product'),
  label: textField('Product label', 80),
  r_per_inch: optionalNumberField('R per inch', { gt: 0, max: 20 }),
  active: booleanField,
});

export const jobTypeField = z.enum(JOB_TYPES, { error: 'Unknown job type' });

/**
 * The tier forms submit one job type's three tiers together, with fields named
 * "good.label", "better.target_r", ... This splits them back into rows.
 */
export function parseTierForm(obj: Record<string, string>): { ok: true; jobType: (typeof JOB_TYPES)[number]; rows: Array<TierRow & { tier: (typeof TIERS)[number] }> } | { ok: false; error: string } {
  const jt = jobTypeField.safeParse(obj.job_type);
  if (!jt.success) return { ok: false, error: issuesMessage(jt.error) };
  const rows: Array<TierRow & { tier: (typeof TIERS)[number] }> = [];
  const errors: string[] = [];
  for (const tier of TIERS) {
    const prefix = `${tier}.`;
    const fields = Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), v]),
    );
    if (Object.keys(fields).length === 0) continue;
    const r = tierRowForm.safeParse(fields);
    if (r.success) rows.push({ ...r.data, tier });
    else errors.push(`${tier[0]!.toUpperCase()}${tier.slice(1)}: ${issuesMessage(r.error)}`);
  }
  if (errors.length) return { ok: false, error: errors.join(' · ') };
  if (rows.length === 0) return { ok: false, error: 'Nothing to save.' };
  return { ok: true, jobType: jt.data, rows };
}

const optionalEmail = (label: string) => optionalTextField(label, 200).pipe(z.email(`${label} is not a valid email`).nullable());
const optionalSender = (label: string) =>
  optionalTextField(label, 200).pipe(
    z
      .string()
      .regex(/^(?:[^<>]+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/, `${label} must be an email, or "Name <email>"`)
      .nullable(),
  );

/** The store's own details (the locations row): name, time zone, contact details and branding. */
export const locationForm = z.object({
  name: textField('Store name', 120),
  short_name: textField('Short name', 60),
  time_zone: textField('Time zone', 64).refine(isTimeZone, 'Time zone must be one like America/New_York'),
  state: textField('State', 2)
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'State must be a two-letter code like DE')),
  default_county: optionalTextField('County', 80),
  climate_zone: textField('Climate zone', 3)
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[1-8][A-C]?$/, 'Climate zone must look like 4A')),
  shop_address: optionalTextField('Shop address', 300),
  phone: optionalTextField('Phone', 50),
  license_number: optionalTextField('License number', 100),
  brand_color: optionalTextField('Brand color', 7).pipe(
    z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Brand color must look like #0f766e')
      .nullable(),
  ),
  logo_path: optionalTextField('Logo URL', 500).pipe(
    z
      .string()
      .regex(/^https:\/\//, 'Logo URL must start with https://')
      .nullable(),
  ),
  utilities: linesField('Utilities', 20, 80),
  quote_from_email: optionalSender('Quote sender'),
  office_notify_email: optionalEmail('Office notification email'),
  owner_report_email: optionalEmail('Owner report email'),
});
export type LocationFormValues = z.infer<typeof locationForm>;

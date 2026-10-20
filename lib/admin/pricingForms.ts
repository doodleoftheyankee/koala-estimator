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

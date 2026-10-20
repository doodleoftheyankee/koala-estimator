// Form schemas for the office jobs page, "Mark lost" on estimates and crew membership on the
// team page. Forms submit strings; these turn them into typed values with readable errors. Pure.
import { z } from 'zod';
import { booleanField, optionalNumberField, optionalTextField, textField, uuidField } from '@/lib/admin/forms';
import { PRODUCTS } from '@/lib/pricing';
import { PRODUCT_UNITS } from './crew';
import { isYmd } from './dates';
import { JOB_STATUSES } from './status';

const blankToNull = z
  .string()
  .optional()
  .transform((s) => (s === undefined || s.trim() === '' ? null : s.trim()));

/** Optional select: blank -> null. */
const optionalId = (label: string) => blankToNull.pipe(z.guid({ error: `${label} is not valid` }).nullable());

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const scheduleForm = z.object({
  id: uuidField('Job'),
  crew_id: optionalId('Crew'),
  scheduled_start: blankToNull.pipe(z.string().refine(isYmd, 'Start date must be a real date (YYYY-MM-DD)').nullable()),
  scheduled_days: optionalNumberField('Scheduled days', { gt: 0, max: 99 }),
});

export const statusForm = z.object({
  id: uuidField('Job'),
  status: z.enum(JOB_STATUSES, { error: 'Pick a status' }),
  confirm: booleanField,
});

export const actualForm = z
  .object({
    job_id: uuidField('Job'),
    id: optionalId('Actuals row'),
    area_id: optionalId('Area'),
    product: blankToNull.pipe(z.enum(PRODUCTS, { error: 'Unknown product' }).nullable()),
    material_unit: blankToNull.pipe(z.enum(PRODUCT_UNITS, { error: 'Unknown unit' }).nullable()),
    material_qty: optionalNumberField('Material used', { min: 0, max: 1_000_000 }),
    hours: optionalNumberField('Person-hours', { min: 0, max: 10_000 }),
    crew_size: optionalNumberField('Crew size', { integer: true, min: 1, max: 20 }),
    drive_minutes: optionalNumberField('Drive minutes', { min: 0, max: 600 }),
    days: optionalNumberField('Days on site', { min: 0, max: 365 }),
    material_cost: optionalNumberField('Material cost', { min: 0, max: 10_000_000 }),
    labor_cost: optionalNumberField('Labor cost', { min: 0, max: 10_000_000 }),
    other_cost: optionalNumberField('Other cost', { min: 0, max: 10_000_000 }),
    // Multipart form posts turn line breaks into CRLF; store them as the crew app does (LF).
    notes: optionalTextField('Notes', 2000).transform((s) => (s === null ? null : normalizeNewlines(s))),
  })
  .refine((f) => (f.area_id === null) === (f.product === null), { message: 'Area and product go together (or neither, for the whole-job row)' });

export const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, '\n');
export type ActualFormData = z.infer<typeof actualForm>;

/** The quantity/hours columns (crew-entered); changing them on a verified row needs an unverify first. */
export function actualValues(f: ActualFormData) {
  const jobRow = f.area_id === null;
  return {
    actual_material_qty: jobRow ? null : f.material_qty,
    actual_material_unit: jobRow || f.material_qty === null ? null : f.material_unit,
    actual_hours: jobRow ? null : f.hours,
    actual_crew_size: jobRow ? f.crew_size : null,
    actual_drive_minutes: jobRow ? f.drive_minutes : null,
    actual_days: jobRow ? f.days : null,
    notes: f.notes,
  };
}

/** The office-only cost columns. */
export function actualCosts(f: ActualFormData) {
  return { actual_material_cost: f.material_cost, actual_labor_cost: f.labor_cost, actual_other_cost: f.other_cost };
}

/** True when any value differs from the stored row (numeric strings from Postgres compared as numbers). */
export function valuesChanged(next: Record<string, string | number | null>, stored: Record<string, unknown>): boolean {
  const norm = (x: unknown): unknown => {
    if (x === null || x === undefined) return null;
    if (typeof x !== 'string') return x;
    const t = normalizeNewlines(x).trim();
    if (t === '') return null;
    return Number.isFinite(Number(t)) ? Number(t) : t;
  };
  return Object.entries(next).some(([k, v]) => norm(v) !== norm(stored[k]));
}

export const jobIdForm = z.object({ id: uuidField('Job') });

export const excludeForm = z
  .object({
    job_id: uuidField('Job'),
    id: uuidField('Actuals row'),
    exclude: booleanField,
    reason: optionalTextField('Reason', 500),
  })
  .refine((f) => !f.exclude || f.reason !== null, { message: 'Give a reason for leaving this row out of learning' });

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

/** Statuses an estimate can be marked lost from (signed is a job; lost/void are final). */
export const LOSABLE_STATUSES = ['draft', 'ready', 'sent', 'viewed', 'expired'] as const;

export function canMarkLost(status: string): boolean {
  return (LOSABLE_STATUSES as readonly string[]).includes(status);
}

export const markLostForm = z.object({
  id: uuidField('Estimate'),
  reason: textField('Reason', 500),
});

// ---------------------------------------------------------------------------
// Crew membership (team page)
// ---------------------------------------------------------------------------

export const MEMBERSHIP_CHOICES = ['none', 'member', 'lead'] as const;
export type MembershipChoice = (typeof MEMBERSHIP_CHOICES)[number];
export interface Membership {
  crewId: string;
  isLead: boolean;
}

export const crewFieldName = (crewId: string) => `crew_${crewId}`;

/** Reads one person's crew choices ("crew_<id>" = none | member | lead) for the given crews. */
export function parseMembershipForm(
  obj: Record<string, string>,
  crewIds: readonly string[],
): { ok: true; profileId: string; memberships: Membership[] } | { ok: false; error: string } {
  const id = uuidField('Team member').safeParse(obj.profile_id);
  if (!id.success) return { ok: false, error: 'Team member is missing or not valid' };
  const memberships: Membership[] = [];
  for (const crewId of crewIds) {
    const raw = obj[crewFieldName(crewId)];
    if (raw === undefined) continue; // crew not on the form: leave it alone
    const choice = z.enum(MEMBERSHIP_CHOICES).safeParse(raw);
    if (!choice.success) return { ok: false, error: 'Pick member, lead or not in this crew' };
    if (choice.data !== 'none') memberships.push({ crewId, isLead: choice.data === 'lead' });
  }
  return { ok: true, profileId: id.data, memberships };
}

/**
 * What to write so the person ends up in exactly `desired` among the crews on the form
 * (`onForm`); memberships of crews not on the form are untouched.
 */
export function membershipChanges(
  existing: readonly Membership[],
  desired: readonly Membership[],
  onForm: readonly string[],
): { upserts: Membership[]; deletes: string[] } {
  const form = new Set(onForm);
  const want = new Map(desired.filter((d) => form.has(d.crewId)).map((d) => [d.crewId, d.isLead]));
  const have = new Map(existing.map((e) => [e.crewId, e.isLead]));
  const upserts = [...want].filter(([crewId, isLead]) => have.get(crewId) !== isLead).map(([crewId, isLead]) => ({ crewId, isLead }));
  const deletes = [...have.keys()].filter((crewId) => form.has(crewId) && !want.has(crewId));
  return { upserts, deletes };
}

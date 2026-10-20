'use server';
// Owner-only edits to the pricing configuration.
//
// Every action: (1) re-checks that the caller is the owner, (2) validates with zod,
// (3) reads the rows it is about to change, (4) writes with the signed-in user's client so
// RLS applies and the audit triggers record the owner as the actor, then (5) rebuilds the
// pricing bundle. If the bundle no longer loads, the previous values are written back and
// the change is refused, so a bad edit can never leave estimators unable to price.
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getSessionProfile } from '@/lib/server/auth';
import { loadPricingBundle } from '@/lib/server/bundle';
import {
  errorMessage,
  failure,
  formToObject,
  isPlaceholder,
  parseWith,
  stripPlaceholder,
  success,
  UNIQUE_VIOLATION,
  type ActionResult,
  type Json,
} from '@/lib/admin/forms';
import { crossCheckSettings, parseSettingsForm, SETTING_LABELS, settingObject, toSettingsMap } from '@/lib/admin/settings';
import {
  codeRequirementForm,
  crewForm,
  materialForm,
  newCrewForm,
  parseTierForm,
  productForm,
} from '@/lib/admin/pricingForms';

type Db = Awaited<ReturnType<typeof createClient>>;
type DbError = { code?: string; message: string } | null;

const NOT_OWNER = 'Only the owner can change pricing.';
const PATH = '/admin/pricing';

/** Throws on a Supabase error so restore steps fail loudly. */
function must<T extends { error: DbError }>(res: T): T {
  if (res.error) throw new Error(res.error.message);
  return res;
}

function friendly(err: NonNullable<DbError>, what: string): string {
  if (err.code === UNIQUE_VIOLATION) return `${what} already exists. Pick a different name.`;
  if (err.code === '42501') return NOT_OWNER;
  return `Saving ${what.toLowerCase()} failed: ${err.message}`;
}

async function ownerDb(): Promise<{ db: Db; userId: string } | null> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return null;
  return { db: await createClient(), userId: profile.userId };
}

/**
 * After a write: rebuild the pricing bundle. On failure restore the previous values and
 * refuse the change; on success revalidate the page.
 */
async function verifyOrRestore(db: Db, restore: () => Promise<void>): Promise<ActionResult> {
  try {
    await loadPricingBundle(db);
  } catch (e) {
    let note = '';
    try {
      await restore();
    } catch (re) {
      note = ` Restoring the previous values also failed (${errorMessage(re)}); reload the page and check this section.`;
    }
    return failure(`This change would break pricing: ${errorMessage(e)}${note}`);
  }
  revalidatePath(PATH);
  return success();
}

/** A write failed part-way: put things back and report the write error. */
async function abortWith(message: string, restore: () => Promise<void>): Promise<ActionResult> {
  try {
    await restore();
  } catch (re) {
    return failure(`${message} Restoring the previous values also failed (${errorMessage(re)}); reload the page and check this section.`);
  }
  return failure(message);
}

// ---------------------------------------------------------------------------
// Business settings
// ---------------------------------------------------------------------------

interface SettingRow {
  key: string;
  value: Json;
  description: string | null;
}

export async function saveSettings(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const { db, userId } = owner;

  const parsed = parseSettingsForm(formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const values = parsed.values;

  if (typeof values.default_crew_id === 'string') {
    const crew = await db.from('crews').select('id').eq('id', values.default_crew_id).eq('active', true).maybeSingle();
    if (crew.error) return failure(crew.error.message);
    if (!crew.data) return failure('The default crew must be an active crew.');
  }

  const all = await db.from('app_settings').select('key, value, description');
  if (all.error) return failure(all.error.message);
  const previous = (all.data as SettingRow[]) ?? [];
  const prevByKey = new Map(previous.map((r) => [r.key, r]));

  // Branding keeps fields this form does not edit (e.g. logo_path).
  if (values.branding && typeof values.branding === 'object' && !Array.isArray(values.branding)) {
    const before = settingObject(toSettingsMap(previous), 'branding') as Record<string, Json>;
    values.branding = { ...before, ...values.branding };
  }

  const merged = { ...toSettingsMap(previous), ...values };
  const cross = crossCheckSettings(merged);
  if (cross) return failure(cross);

  const now = new Date().toISOString();
  const keys = Object.keys(values);
  const rows = keys.map((key) => {
    const before = prevByKey.get(key);
    const description = before?.description ?? null;
    return {
      key,
      value: values[key] as Json,
      description: isPlaceholder(description) ? stripPlaceholder(description, SETTING_LABELS[key] ?? null) : description,
      updated_at: now,
      updated_by: userId,
    };
  });

  const restore = async () => {
    const existed = keys.map((k) => prevByKey.get(k)).filter((r): r is SettingRow => !!r);
    const added = keys.filter((k) => !prevByKey.has(k));
    if (existed.length) {
      must(
        await db
          .from('app_settings')
          .upsert(existed.map((r) => ({ key: r.key, value: r.value, description: r.description, updated_at: now, updated_by: userId })), { onConflict: 'key' }),
      );
    }
    if (added.length) must(await db.from('app_settings').delete().in('key', added));
  };

  const write = await db.from('app_settings').upsert(rows, { onConflict: 'key' }).select('key');
  if (write.error) return abortWith(friendly(write.error, 'Settings'), restore);
  if ((write.data ?? []).length !== rows.length) return abortWith(NOT_OWNER, restore);

  return verifyOrRestore(db, restore);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export async function saveMaterial(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const { db } = owner;

  const parsed = parseWith(materialForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const input = parsed.data;

  const prev = await db
    .from('materials')
    .select('id, name, unit, cost_per_unit, coverage_sqft_in, needs_owner_input')
    .eq('id', input.id)
    .maybeSingle();
  if (prev.error) return failure(prev.error.message);
  if (!prev.data) return failure('That material no longer exists. Reload the page.');
  const before = prev.data as { name: string; unit: string; cost_per_unit: number | string; coverage_sqft_in: number | string | null; needs_owner_input: boolean };

  const isBag = before.unit === 'bag';
  if (isBag && input.coverage_sqft_in === null) return failure('Bag materials need a coverage (sq ft × inches per bag).');

  const restore = async () => {
    must(
      await db
        .from('materials')
        .update({
          name: before.name,
          cost_per_unit: before.cost_per_unit,
          coverage_sqft_in: before.coverage_sqft_in,
          needs_owner_input: before.needs_owner_input,
        })
        .eq('id', input.id),
    );
  };

  const write = await db
    .from('materials')
    .update({
      name: input.name,
      cost_per_unit: input.cost_per_unit,
      // Coverage only means something for bags; other units keep what they had.
      coverage_sqft_in: isBag ? input.coverage_sqft_in : before.coverage_sqft_in,
      needs_owner_input: false,
    })
    .eq('id', input.id)
    .select('id');
  if (write.error) return failure(friendly(write.error, 'Material'));
  if (!write.data?.length) return failure(NOT_OWNER);

  return verifyOrRestore(db, restore);
}

// ---------------------------------------------------------------------------
// Crews
// ---------------------------------------------------------------------------

async function defaultCrewId(db: Db): Promise<string | null> {
  const r = await db.from('app_settings').select('value').eq('key', 'default_crew_id').maybeSingle();
  const v = (r.data as { value: unknown } | null)?.value;
  return typeof v === 'string' ? v : null;
}

export async function saveCrew(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const { db } = owner;

  const parsed = parseWith(crewForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const input = parsed.data;

  const prev = await db.from('crews').select('id, name, size, blended_hourly_cost, active, needs_owner_input').eq('id', input.id).maybeSingle();
  if (prev.error) return failure(prev.error.message);
  if (!prev.data) return failure('That crew no longer exists. Reload the page.');
  const before = prev.data as { name: string; size: number; blended_hourly_cost: number | string; active: boolean; needs_owner_input: boolean };

  if (!input.active && before.active && (await defaultCrewId(db)) === input.id) {
    return failure('This is the default crew. Pick a different default crew in Business settings before deactivating it.');
  }

  const restore = async () => {
    must(
      await db
        .from('crews')
        .update({
          name: before.name,
          size: before.size,
          blended_hourly_cost: before.blended_hourly_cost,
          active: before.active,
          needs_owner_input: before.needs_owner_input,
        })
        .eq('id', input.id),
    );
  };

  const write = await db
    .from('crews')
    .update({ name: input.name, size: input.size, blended_hourly_cost: input.blended_hourly_cost, active: input.active, needs_owner_input: false })
    .eq('id', input.id)
    .select('id');
  if (write.error) return failure(friendly(write.error, 'A crew with that name'));
  if (!write.data?.length) return failure(NOT_OWNER);

  return verifyOrRestore(db, restore);
}

export async function addCrew(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const { db } = owner;

  const parsed = parseWith(newCrewForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const input = parsed.data;

  const write = await db
    .from('crews')
    .insert({ name: input.name, size: input.size, blended_hourly_cost: input.blended_hourly_cost, active: true, needs_owner_input: false })
    .select('id')
    .single();
  if (write.error) return failure(friendly(write.error, 'A crew with that name'));
  const id = (write.data as { id: string }).id;

  const result = await verifyOrRestore(db, async () => {
    must(await db.from('crews').delete().eq('id', id));
  });
  return result.ok ? success(`Added ${input.name}.`) : result;
}

// ---------------------------------------------------------------------------
// Good / better / best templates
// ---------------------------------------------------------------------------

interface TierBefore {
  id: string;
  job_type: string;
  label: string;
  primary_product: string;
  target_r: number | string | null;
  include_air_sealing: boolean;
  include_removal: boolean;
  marketing_bullets: string[];
  active: boolean;
}

export async function saveTierTemplates(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const { db } = owner;

  const parsed = parseTierForm(formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { jobType, rows } = parsed;

  const [prev, products] = await Promise.all([
    db
      .from('tier_templates')
      .select('id, job_type, label, primary_product, target_r, include_air_sealing, include_removal, marketing_bullets, active')
      .in(
        'id',
        rows.map((r) => r.id),
      ),
    db.from('products').select('code').eq('active', true),
  ]);
  if (prev.error) return failure(prev.error.message);
  if (products.error) return failure(products.error.message);
  const before = (prev.data as TierBefore[]) ?? [];
  if (before.length !== rows.length || before.some((b) => b.job_type !== jobType)) {
    return failure('These tiers changed since the page loaded. Reload and try again.');
  }
  const activeCodes = new Set(((products.data as Array<{ code: string }>) ?? []).map((p) => p.code));
  for (const r of rows) {
    if (r.active && !activeCodes.has(r.primary_product)) return failure(`${r.label}: its primary product is inactive. Activate it under Products first.`);
    if (r.active && r.include_air_sealing && !activeCodes.has('air_sealing')) return failure(`${r.label}: air sealing is inactive under Products.`);
    if (r.active && r.include_removal && !activeCodes.has('removal')) return failure(`${r.label}: removal is inactive under Products.`);
  }

  const restore = async () => {
    for (const b of before) {
      must(
        await db
          .from('tier_templates')
          .update({
            label: b.label,
            primary_product: b.primary_product,
            target_r: b.target_r,
            include_air_sealing: b.include_air_sealing,
            include_removal: b.include_removal,
            marketing_bullets: b.marketing_bullets,
            active: b.active,
          })
          .eq('id', b.id),
      );
    }
  };

  for (const r of rows) {
    const write = await db
      .from('tier_templates')
      .update({
        label: r.label,
        primary_product: r.primary_product,
        target_r: r.target_r,
        include_air_sealing: r.include_air_sealing,
        include_removal: r.include_removal,
        marketing_bullets: r.marketing_bullets,
        active: r.active,
      })
      .eq('id', r.id)
      .eq('job_type', jobType)
      .select('id');
    if (write.error) return abortWith(friendly(write.error, 'Tier'), restore);
    if (!write.data?.length) return abortWith(NOT_OWNER, restore);
  }

  return verifyOrRestore(db, restore);
}

// ---------------------------------------------------------------------------
// Code minimums
// ---------------------------------------------------------------------------

export async function saveCodeRequirement(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const { db } = owner;

  const parsed = parseWith(codeRequirementForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const input = parsed.data;

  const prev = await db.from('code_requirements').select('min_r, alt_spec, code_edition, source_note').eq('id', input.id).maybeSingle();
  if (prev.error) return failure(prev.error.message);
  if (!prev.data) return failure('That code requirement no longer exists. Reload the page.');
  const before = prev.data as { min_r: number | string; alt_spec: string | null; code_edition: string; source_note: string | null };

  const restore = async () => {
    must(await db.from('code_requirements').update({ ...before, updated_at: new Date().toISOString() }).eq('id', input.id));
  };

  const write = await db
    .from('code_requirements')
    .update({
      min_r: input.min_r,
      alt_spec: input.alt_spec,
      code_edition: input.code_edition,
      source_note: input.source_note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.id)
    .select('id');
  if (write.error) {
    if (write.error.code === UNIQUE_VIOLATION) return failure('That job type and assembly already has a row for this code edition.');
    return failure(friendly(write.error, 'Code requirement'));
  }
  if (!write.data?.length) return failure(NOT_OWNER);

  return verifyOrRestore(db, restore);
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function saveProduct(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const { db } = owner;

  const parsed = parseWith(productForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const input = parsed.data;

  const prev = await db.from('products').select('code, label, r_per_inch, is_r_bearing, active').eq('id', input.id).maybeSingle();
  if (prev.error) return failure(prev.error.message);
  if (!prev.data) return failure('That product no longer exists. Reload the page.');
  const before = prev.data as { code: string; label: string; r_per_inch: number | string | null; is_r_bearing: boolean; active: boolean };

  if (before.is_r_bearing && input.r_per_inch === null) return failure(`${input.label} needs an R per inch.`);
  const rPerInch = before.is_r_bearing ? input.r_per_inch : null;

  if (before.active && !input.active) {
    // A tier that still uses this product would fail at pricing time; refuse up front.
    let q = db.from('tier_templates').select('job_type, tier, label').eq('active', true);
    if (before.code === 'air_sealing') q = q.eq('include_air_sealing', true);
    else if (before.code === 'removal') q = q.eq('include_removal', true);
    else q = q.eq('primary_product', before.code);
    const users = await q;
    if (users.error) return failure(users.error.message);
    const list = (users.data as Array<{ job_type: string; tier: string; label: string }>) ?? [];
    if (list.length) {
      const names = list
        .slice(0, 4)
        .map((t) => `${t.job_type.replace('_', ' ')} ${t.tier} (${t.label})`)
        .join(', ');
      return failure(`Still used by active tiers: ${names}${list.length > 4 ? ', …' : ''}. Change or deactivate those tiers first.`);
    }
  }

  const restore = async () => {
    must(await db.from('products').update({ label: before.label, r_per_inch: before.r_per_inch, active: before.active }).eq('id', input.id));
  };

  const write = await db.from('products').update({ label: input.label, r_per_inch: rPerInch, active: input.active }).eq('id', input.id).select('id');
  if (write.error) return failure(friendly(write.error, 'Product'));
  if (!write.data?.length) return failure(NOT_OWNER);

  return verifyOrRestore(db, restore);
}

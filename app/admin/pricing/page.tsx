import type { Metadata } from 'next';
import { z } from 'zod';
import { AppNav } from '@/components/AppNav';
import { Alert, Badge, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { JOB_TYPES, PRODUCTS, TIERS, type JobType, type ProductCode } from '@/lib/pricing';
import { errorMessage, fractionToPercent, isPlaceholder } from '@/lib/admin/forms';
import {
  BRANDING_FIELDS,
  displayValue,
  objectFieldText,
  SETTING_GROUPS,
  SETTING_LABELS,
  settingBool,
  settingObject,
  toSettingsMap,
  type ScalarSetting,
  type SettingsMap,
} from '@/lib/admin/settings';
import { PRIMARY_PRODUCTS } from '@/lib/admin/pricingForms';
import { ActionForm, ToggleInput } from './ActionForm';
import { NumberField, SectionHeading, TextField } from './fields';
import { addCrew, saveCodeRequirement, saveCrew, saveMaterial, saveProduct, saveSettings, saveTierTemplates } from './actions';

export const metadata: Metadata = { title: 'Pricing' };

// ---------------------------------------------------------------------------
// Row parsing at the boundary (numeric columns can arrive as strings)
// ---------------------------------------------------------------------------

const num = z.coerce.number();
const numOrNull = z
  .union([z.number(), z.string()])
  .nullable()
  .transform((v) => (v === null ? null : Number(v)));
const str = z.string();
const strOrNull = z.string().nullable();

const schemas = {
  settings: z.array(z.object({ key: str, value: z.unknown(), description: strOrNull })),
  jobTypes: z.array(z.object({ code: z.enum(JOB_TYPES), label: str })),
  products: z.array(
    z.object({ id: str, code: z.enum(PRODUCTS), label: str, unit: str, r_per_inch: numOrNull, is_r_bearing: z.boolean(), active: z.boolean() }),
  ),
  materials: z.array(
    z.object({
      id: str,
      product_id: str,
      name: str,
      unit: str,
      cost_per_unit: num,
      coverage_sqft_in: numOrNull,
      is_default: z.boolean(),
      needs_owner_input: z.boolean(),
    }),
  ),
  crews: z.array(z.object({ id: str, name: str, size: num, blended_hourly_cost: num, active: z.boolean(), needs_owner_input: z.boolean() })),
  tiers: z.array(
    z.object({
      id: str,
      job_type: z.enum(JOB_TYPES),
      tier: z.enum(TIERS),
      label: str,
      primary_product: str,
      target_r: numOrNull,
      include_air_sealing: z.boolean(),
      include_removal: z.boolean(),
      marketing_bullets: z.array(str).nullable(),
      active: z.boolean(),
    }),
  ),
  codes: z.array(
    z.object({
      id: str,
      job_type: z.enum(JOB_TYPES),
      assembly: str,
      min_r: num,
      alt_spec: strOrNull,
      code_edition: str,
      source_note: strOrNull,
      is_default: z.boolean(),
    }),
  ),
  set: z.object({ id: str, version: num, source: str, notes: strOrNull, activated_at: strOrNull }).nullable(),
  coefficients: z.array(
    z.object({
      kind: str,
      product: strOrNull,
      job_type: strOrNull,
      access_level: strOrNull,
      value: num,
      prior_value: num,
      sample_size: num,
      confidence: num,
    }),
  ),
};

type Db = Awaited<ReturnType<typeof createClient>>;

async function loadConfig(db: Db) {
  const [settings, jobTypes, products, materials, crews, tiers, codes, set] = await Promise.all([
    db.from('app_settings').select('key, value, description').order('key'),
    db.from('job_types').select('code, label').order('sort_order'),
    db.from('products').select('id, code, label, unit, r_per_inch, is_r_bearing, active'),
    db
      .from('materials')
      .select('id, product_id, name, unit, cost_per_unit, coverage_sqft_in, is_default, needs_owner_input')
      .eq('active', true),
    db.from('crews').select('id, name, size, blended_hourly_cost, active, needs_owner_input').order('name'),
    db
      .from('tier_templates')
      .select('id, job_type, tier, label, primary_product, target_r, include_air_sealing, include_removal, marketing_bullets, active'),
    db.from('code_requirements').select('id, job_type, assembly, min_r, alt_spec, code_edition, source_note, is_default').order('job_type').order('assembly'),
    db.from('coefficient_sets').select('id, version, source, notes, activated_at').eq('status', 'active').maybeSingle(),
  ]);
  for (const r of [settings, jobTypes, products, materials, crews, tiers, codes, set]) {
    if (r.error) throw new Error(r.error.message);
  }
  const activeSet = schemas.set.parse(set.data);
  let coefficients: z.infer<typeof schemas.coefficients> = [];
  if (activeSet) {
    const c = await db
      .from('coefficients')
      .select('kind, product, job_type, access_level, value, prior_value, sample_size, confidence')
      .eq('set_id', activeSet.id)
      .order('kind');
    if (c.error) throw new Error(c.error.message);
    coefficients = schemas.coefficients.parse(c.data);
  }
  const productOrder = (code: string) => PRODUCTS.indexOf(code as ProductCode);
  return {
    settings: schemas.settings.parse(settings.data),
    jobTypes: schemas.jobTypes.parse(jobTypes.data),
    products: schemas.products.parse(products.data).sort((a, b) => productOrder(a.code) - productOrder(b.code)),
    materials: schemas.materials.parse(materials.data),
    crews: schemas.crews.parse(crews.data),
    tiers: schemas.tiers.parse(tiers.data),
    codes: schemas.codes.parse(codes.data).sort((a, b) => JOB_TYPES.indexOf(a.job_type) - JOB_TYPES.indexOf(b.job_type)),
    activeSet,
    coefficients: coefficients.sort((a, b) =>
      `${a.kind}/${a.product ?? ''}/${a.job_type ?? ''}/${a.access_level ?? ''}`.localeCompare(
        `${b.kind}/${b.product ?? ''}/${b.job_type ?? ''}/${b.access_level ?? ''}`,
      ),
    ),
  };
}

type Config = Awaited<ReturnType<typeof loadConfig>>;

const UNIT_LABELS: Record<string, string> = {
  board_ft: 'board ft',
  bag: 'bag',
  sqft: 'sq ft',
  linear_ft: 'linear ft',
  hour: 'hour',
  each: 'each',
};
const TIER_LABELS = { good: 'Good', better: 'Better', best: 'Best' } as const;
const humanize = (s: string | null) => (s ? s.replace(/_/g, ' ') : '—');

const SECTIONS = [
  { id: 'business', label: 'Business' },
  { id: 'materials', label: 'Materials' },
  { id: 'crews', label: 'Crews' },
  { id: 'tiers', label: 'Good / better / best' },
  { id: 'code', label: 'Code minimums' },
  { id: 'products', label: 'Products' },
  { id: 'coefficients', label: 'Coefficients' },
] as const;

export default async function PricingPage() {
  const profile = await requireRole('owner', 'office');
  const readOnly = profile.role !== 'owner';
  const db = await createClient();

  let config: Config | null = null;
  let loadError: string | null = null;
  try {
    config = await loadConfig(db);
  } catch (e) {
    loadError = errorMessage(e);
  }

  return (
    <>
      <AppNav profile={profile} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">Pricing</h1>
          {readOnly ? <Badge tone="blue">Read-only</Badge> : null}
        </div>
        {readOnly ? <Alert tone="blue">You can view the pricing setup. Only the owner can change it.</Alert> : null}
        {loadError || !config ? (
          <Alert tone="red">Could not load the pricing configuration: {loadError}</Alert>
        ) : (
          <PricingContent config={config} readOnly={readOnly} />
        )}
      </main>
    </>
  );
}

function PricingContent({ config, readOnly }: { config: Config; readOnly: boolean }) {
  const map = toSettingsMap(config.settings);
  const productById = new Map(config.products.map((p) => [p.id, p]));
  const productByCode = new Map(config.products.map((p) => [p.code, p]));
  const jobTypeLabel = (jt: JobType) => config.jobTypes.find((j) => j.code === jt)?.label ?? humanize(jt);

  const placeholderSettings = config.settings.filter((s) => isPlaceholder(s.description) || isPlaceholder(s.value));
  const placeholderKeys = new Set(placeholderSettings.map((s) => s.key));
  const flaggedMaterials = config.materials.filter((m) => m.needs_owner_input);
  const flaggedCrews = config.crews.filter((c) => c.needs_owner_input);
  const todo = [
    ...placeholderSettings.map((s) => ({ href: '#business', text: `Setting: ${SETTING_LABELS[s.key] ?? humanize(s.key)}` })),
    ...flaggedMaterials.map((m) => ({ href: '#materials', text: `Material: ${m.name} (${productById.get(m.product_id)?.label ?? 'product'})` })),
    ...flaggedCrews.map((c) => ({ href: '#crews', text: `Crew: ${c.name}` })),
  ];

  const defaultMaterials = config.materials
    .filter((m) => m.is_default && productById.has(m.product_id))
    .sort((a, b) => PRODUCTS.indexOf(productById.get(a.product_id)!.code) - PRODUCTS.indexOf(productById.get(b.product_id)!.code));
  const activeCrews = config.crews.filter((c) => c.active);
  const defaultCrewId = typeof map.default_crew_id === 'string' ? map.default_crew_id : null;

  return (
    <>
      {todo.length ? (
        <Alert tone="amber">
          <p className="font-semibold">Needs owner input ({todo.length})</p>
          <p className="mt-1">These are still seed placeholders. Pricing works, but it will not match how you quote until they are set.</p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {todo.map((t) => (
              <li key={t.text}>
                <a href={t.href} className="underline decoration-amber-400 underline-offset-2 hover:text-amber-950">
                  {t.text}
                </a>
              </li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert tone="green">All seed placeholders have been filled in.</Alert>
      )}

      <nav aria-label="Pricing sections" className="sticky top-0 z-10 -mx-4 overflow-x-auto border-b border-slate-200 bg-slate-50/95 px-4 py-2 backdrop-blur">
        <ul className="flex gap-2 whitespace-nowrap">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="inline-flex min-h-10 items-center rounded-full bg-white px-4 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-brand-50 hover:text-brand-800">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* ------------------------------------------------------------- Business */}
      <section className="space-y-4">
        <SectionHeading id="business" title="Business settings">
          Percentages are entered as percents (18 = 18%). Each card saves on its own.
        </SectionHeading>

        {SETTING_GROUPS.map((group) => (
          <Card key={group.id}>
            <h3 className="mb-3 font-semibold text-slate-900">{group.title}</h3>
            <ActionForm action={saveSettings} readOnly={readOnly}>
              <div className={group.id === 'quote-text' ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3'}>
                {group.settings.map((s) => (
                  <SettingInput key={s.key} setting={s} map={map} crews={activeCrews} placeholder={placeholderKeys.has(s.key)} />
                ))}
              </div>
            </ActionForm>
          </Card>
        ))}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 font-semibold text-slate-900">
              Financing {placeholderKeys.has('financing') ? <Badge tone="amber">Placeholder</Badge> : null}
            </h3>
            <FinancingForm map={map} readOnly={readOnly} />
          </Card>
          <Card>
            <h3 className="mb-3 font-semibold text-slate-900">
              Branding {placeholderKeys.has('branding') ? <Badge tone="amber">Placeholder</Badge> : null}
            </h3>
            <BrandingForm map={map} readOnly={readOnly} />
          </Card>
        </div>
      </section>

      {/* ------------------------------------------------------------ Materials */}
      <section className="space-y-4">
        <SectionHeading id="materials" title="Materials">
          The default material for each product. Saving a material marks it as confirmed.
        </SectionHeading>
        <div className="grid gap-4 md:grid-cols-2">
          {defaultMaterials.map((m) => {
            const product = productById.get(m.product_id);
            const unit = UNIT_LABELS[m.unit] ?? m.unit;
            return (
              <Card key={m.id}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-slate-900">{product?.label}</h3>
                  {m.needs_owner_input ? <Badge tone="amber">Needs owner input</Badge> : null}
                  {product && !product.active ? <Badge>Product inactive</Badge> : null}
                </div>
                <ActionForm action={saveMaterial} readOnly={readOnly}>
                  <input type="hidden" name="id" value={m.id} />
                  <TextField label="Name" name="name" defaultValue={m.name} required />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Unit" hint="Set by the product">
                      <Input value={unit} readOnly disabled aria-readonly="true" />
                    </Field>
                    <NumberField label="Cost per unit" name="cost_per_unit" defaultValue={m.cost_per_unit} prefix="$" suffix={`/ ${unit}`} />
                  </div>
                  {m.unit === 'bag' ? (
                    <NumberField
                      label="Coverage per bag"
                      name="coverage_sqft_in"
                      defaultValue={m.coverage_sqft_in}
                      suffix="sq ft·in"
                      hint="Square feet × inches one bag covers (e.g. 200 = 40 sq ft at 5 in)."
                    />
                  ) : null}
                </ActionForm>
              </Card>
            );
          })}
        </div>
        {defaultMaterials.length === 0 ? <Alert tone="red">No default materials found.</Alert> : null}
      </section>

      {/* ---------------------------------------------------------------- Crews */}
      <section className="space-y-4">
        <SectionHeading id="crews" title="Crews">
          Hourly cost is per person-hour, fully burdened (wages, taxes, insurance, benefits).
        </SectionHeading>
        <div className="grid gap-4 md:grid-cols-2">
          {config.crews.map((c) => (
            <Card key={c.id}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-slate-900">{c.name}</h3>
                {c.id === defaultCrewId ? <Badge tone="blue">Default</Badge> : null}
                {c.needs_owner_input ? <Badge tone="amber">Needs owner input</Badge> : null}
                {!c.active ? <Badge>Inactive</Badge> : null}
              </div>
              <ActionForm action={saveCrew} readOnly={readOnly}>
                <input type="hidden" name="id" value={c.id} />
                <TextField label="Name" name="name" defaultValue={c.name} required />
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberField label="Crew size" name="size" defaultValue={c.size} integer suffix="people" />
                  <NumberField label="Blended hourly cost" name="blended_hourly_cost" defaultValue={c.blended_hourly_cost} prefix="$" suffix="/ person-hr" />
                </div>
                <ToggleInput name="active" label="Active" hint="Inactive crews are not offered on estimates" defaultChecked={c.active} />
              </ActionForm>
            </Card>
          ))}
          {readOnly ? null : (
            <Card className="border-2 border-dashed border-slate-300 shadow-none ring-0">
              <h3 className="mb-3 font-semibold text-slate-900">Add a crew</h3>
              <ActionForm action={addCrew} readOnly={readOnly} submitLabel="Add crew" resetOnSuccess>
                <TextField label="Name" name="name" defaultValue="" required placeholder="Crew B" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberField label="Crew size" name="size" defaultValue="" integer suffix="people" placeholder="2" />
                  <NumberField label="Blended hourly cost" name="blended_hourly_cost" defaultValue="" prefix="$" suffix="/ person-hr" />
                </div>
              </ActionForm>
            </Card>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- Tiers */}
      <section className="space-y-4">
        <SectionHeading id="tiers" title="Good / better / best">
          The three options offered for each job type. Leave target R blank to use the code minimum. Bullets appear on the quote, one per line.
        </SectionHeading>
        {JOB_TYPES.map((jt) => {
          const rows = TIERS.map((t) => config.tiers.find((r) => r.job_type === jt && r.tier === t));
          const codeMin = config.codes.find((c) => c.job_type === jt && c.is_default);
          return (
            <Card key={jt}>
              <h3 className="mb-3 text-lg font-semibold text-slate-900">{jobTypeLabel(jt)}</h3>
              <ActionForm action={saveTierTemplates} readOnly={readOnly} submitLabel={`Save ${jobTypeLabel(jt).toLowerCase()} tiers`}>
                <input type="hidden" name="job_type" value={jt} />
                <div className="grid gap-4 lg:grid-cols-3">
                  {TIERS.map((tier, i) => {
                    const row = rows[i];
                    if (!row) {
                      return (
                        <div key={tier} className="rounded-xl bg-slate-50 p-3 text-sm text-slate-500 ring-1 ring-slate-200">
                          No {TIER_LABELS[tier].toLowerCase()} template for this job type.
                        </div>
                      );
                    }
                    const p = (f: string) => `${tier}.${f}`;
                    return (
                      <div key={tier} className="space-y-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold uppercase tracking-wide text-brand-800">{TIER_LABELS[tier]}</span>
                          {!row.active ? <Badge>Inactive</Badge> : null}
                        </div>
                        <input type="hidden" name={p('id')} value={row.id} />
                        <TextField label="Label" name={p('label')} defaultValue={row.label} required />
                        <Field label="Primary product">
                          <Select name={p('primary_product')} defaultValue={row.primary_product} required>
                            {PRIMARY_PRODUCTS.map((code) => {
                              const prod = productByCode.get(code);
                              return (
                                <option key={code} value={code}>
                                  {prod?.label ?? humanize(code)}
                                  {prod && !prod.active ? ' (inactive)' : ''}
                                </option>
                              );
                            })}
                          </Select>
                        </Field>
                        <NumberField
                          label="Target R"
                          name={p('target_r')}
                          defaultValue={row.target_r}
                          required={false}
                          placeholder={codeMin ? `Code minimum (R-${codeMin.min_r})` : 'Code minimum'}
                          hint="Blank = code minimum"
                        />
                        <ToggleInput name={p('include_air_sealing')} label="Include air sealing" defaultChecked={row.include_air_sealing} />
                        <ToggleInput name={p('include_removal')} label="Include removal" defaultChecked={row.include_removal} />
                        <Field label="Quote bullets" hint="One per line">
                          <Textarea name={p('marketing_bullets')} rows={4} defaultValue={(row.marketing_bullets ?? []).join('\n')} />
                        </Field>
                        <ToggleInput name={p('active')} label="Active" defaultChecked={row.active} />
                      </div>
                    );
                  })}
                </div>
              </ActionForm>
            </Card>
          );
        })}
      </section>

      {/* ------------------------------------------------------------ Code mins */}
      <section className="space-y-4">
        <SectionHeading id="code" title="Code minimums">
          Minimum R-values by job type and assembly (IECC climate zone 4A).
        </SectionHeading>
        <Alert tone="amber">
          <strong>Owner to confirm:</strong> these were seeded from the <strong>2021 IECC</strong> (attic R-60). Delaware has used both the 2018
          (attic R-49) and 2021 editions. Confirm which edition Newark and New Castle County enforce for your permits, then update the values and
          edition below.
        </Alert>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {config.codes.map((c) => (
            <Card key={c.id}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-slate-900">
                  {jobTypeLabel(c.job_type)} · <span className="capitalize">{humanize(c.assembly)}</span>
                </h3>
                {!c.is_default ? <Badge>Not default</Badge> : null}
              </div>
              <ActionForm action={saveCodeRequirement} readOnly={readOnly}>
                <input type="hidden" name="id" value={c.id} />
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="Minimum R-value" name="min_r" defaultValue={c.min_r} />
                  <TextField label="Alt. spec" name="alt_spec" defaultValue={c.alt_spec} placeholder="13+5ci" />
                </div>
                <TextField label="Code edition" name="code_edition" defaultValue={c.code_edition} required />
                <TextField label="Source note" name="source_note" defaultValue={c.source_note} />
              </ActionForm>
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- Products */}
      <section className="space-y-4">
        <SectionHeading id="products" title="Products">
          A product used by an active tier cannot be deactivated.
        </SectionHeading>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {config.products.map((p) => (
            <Card key={p.id}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-slate-900">{p.label}</h3>
                <code className="rounded bg-slate-100 px-1.5 text-xs text-slate-600">{p.code}</code>
                <span className="text-xs text-slate-500">per {UNIT_LABELS[p.unit] ?? p.unit}</span>
                {!p.active ? <Badge>Inactive</Badge> : null}
              </div>
              <ActionForm action={saveProduct} readOnly={readOnly}>
                <input type="hidden" name="id" value={p.id} />
                <TextField label="Label" name="label" defaultValue={p.label} required />
                {p.is_r_bearing ? (
                  <NumberField label="R per inch" name="r_per_inch" defaultValue={p.r_per_inch} suffix="R / in" />
                ) : (
                  <p className="text-sm text-slate-500">Not an insulating product (no R-value).</p>
                )}
                <ToggleInput name="active" label="Active" defaultChecked={p.active} />
              </ActionForm>
            </Card>
          ))}
        </div>
      </section>

      {/* --------------------------------------------------------- Coefficients */}
      <section className="space-y-4 pb-10">
        <SectionHeading id="coefficients" title="Learned coefficients">
          Read-only. Waste factors, labor rates and multipliers the pricing engine uses.
        </SectionHeading>
        <Alert tone="blue">
          Phase 2 adds nightly learning from job actuals, with owner approval of each new set and one-click rollback. Until then these are the seed
          priors.
        </Alert>
        {config.activeSet ? (
          <Card className="p-0">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-4">
              <h3 className="font-semibold text-slate-900">Active set v{config.activeSet.version}</h3>
              <Badge tone="green">{config.activeSet.source}</Badge>
              {config.activeSet.activated_at ? (
                <span className="text-sm text-slate-500">since {new Date(config.activeSet.activated_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}</span>
              ) : null}
              {config.activeSet.notes ? <span className="w-full text-sm text-slate-600">{config.activeSet.notes}</span> : null}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-2">Kind</th>
                    <th scope="col" className="px-4 py-2">Product</th>
                    <th scope="col" className="px-4 py-2">Job type</th>
                    <th scope="col" className="px-4 py-2">Access</th>
                    <th scope="col" className="px-4 py-2 text-right">Value</th>
                    <th scope="col" className="px-4 py-2 text-right">Prior</th>
                    <th scope="col" className="px-4 py-2 text-right">Samples</th>
                    <th scope="col" className="px-4 py-2 text-right">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {config.coefficients.map((c) => {
                    const delta = c.prior_value ? (c.value - c.prior_value) / c.prior_value : 0;
                    return (
                      <tr key={`${c.kind}/${c.product}/${c.job_type}/${c.access_level}`}>
                        <td className="px-4 py-2 font-medium capitalize text-slate-800">{humanize(c.kind)}</td>
                        <td className="px-4 py-2">{c.product ? (productByCode.get(c.product as ProductCode)?.label ?? humanize(c.product)) : 'All'}</td>
                        <td className="px-4 py-2 capitalize">{c.job_type ? jobTypeLabel(c.job_type as JobType) : 'All'}</td>
                        <td className="px-4 py-2 capitalize">{c.access_level ?? 'All'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {c.value.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                          {Math.abs(delta) > 1e-9 ? (
                            <span className={delta > 0 ? 'ml-1 text-xs text-amber-700' : 'ml-1 text-xs text-sky-700'}>
                              {delta > 0 ? '+' : ''}
                              {fractionToPercent(Number(delta.toFixed(4)))}%
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-500">{c.prior_value.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{c.sample_size}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{c.confidence.toFixed(0)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Alert tone="red">No active coefficient set. Pricing will not work until one is activated.</Alert>
        )}
      </section>
    </>
  );
}

function placeholderHint(hint: string | undefined, placeholder: boolean) {
  if (!placeholder) return hint;
  return (
    <>
      <span className="font-medium text-amber-700">Placeholder — confirm this value.</span>
      {hint ? ` ${hint}` : null}
    </>
  );
}

function SettingInput({
  setting: s,
  map,
  crews,
  placeholder,
}: {
  setting: ScalarSetting;
  map: SettingsMap;
  crews: Array<{ id: string; name: string }>;
  placeholder: boolean;
}) {
  const hint = placeholderHint(s.hint, placeholder);
  switch (s.kind) {
    case 'percent':
      return <NumberField label={s.label} name={s.key} defaultValue={displayValue(map, s)} suffix="%" hint={hint} />;
    case 'money':
      return <NumberField label={s.label} name={s.key} defaultValue={displayValue(map, s)} prefix="$" hint={hint} />;
    case 'number':
      return <NumberField label={s.label} name={s.key} defaultValue={displayValue(map, s)} hint={hint} />;
    case 'integer':
      return <NumberField label={s.label} name={s.key} defaultValue={displayValue(map, s)} integer hint={hint} />;
    case 'boolean':
      return (
        <div className="self-end">
          <ToggleInput name={s.key} label={s.label} hint={s.hint} defaultChecked={settingBool(map, s.key)} />
        </div>
      );
    case 'crew': {
      const current = displayValue(map, s);
      return (
        <Field label={s.label} hint={hint}>
          <Select name={s.key} defaultValue={current} required>
            {crews.some((c) => c.id === current) ? null : <option value="">Pick a crew</option>}
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case 'textarea':
      return (
        <Field label={s.label} hint={hint}>
          <Textarea name={s.key} rows={5} required defaultValue={displayValue(map, s)} />
        </Field>
      );
    case 'text':
      return <TextField label={s.label} name={s.key} defaultValue={displayValue(map, s)} required hint={hint} />;
  }
}

function FinancingForm({ map, readOnly }: { map: SettingsMap; readOnly: boolean }) {
  const fin = settingObject(map, 'financing');
  const apr = Number(fin.apr);
  return (
    <ActionForm action={saveSettings} readOnly={readOnly}>
      <TextField label="Provider" name="financing.provider" defaultValue={objectFieldText(fin, 'provider')} placeholder="e.g. GreenSky" />
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField label="APR" name="financing.apr" defaultValue={Number.isFinite(apr) ? fractionToPercent(apr) : ''} suffix="%" />
        <NumberField label="Term" name="financing.term_months" defaultValue={objectFieldText(fin, 'term_months')} integer suffix="months" />
      </div>
      <ToggleInput name="financing.show" label="Show “as low as” monthly payment on quotes" defaultChecked={fin.show === true} />
    </ActionForm>
  );
}

function BrandingForm({ map, readOnly }: { map: SettingsMap; readOnly: boolean }) {
  const brand = settingObject(map, 'branding');
  const color = objectFieldText(brand, 'primary_color');
  return (
    <ActionForm action={saveSettings} readOnly={readOnly}>
      <div className="grid gap-3 sm:grid-cols-2">
        {BRANDING_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            name={`branding.${f.key}`}
            type={f.type}
            required={f.key === 'company'}
            defaultValue={objectFieldText(brand, f.key)}
            placeholder={f.key === 'primary_color' ? '#0f766e' : undefined}
            hint={
              f.key === 'primary_color' && /^#[0-9a-fA-F]{6}$/.test(color) ? (
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden className="inline-block h-3 w-3 rounded-sm ring-1 ring-slate-300" style={{ backgroundColor: color }} /> Current color
                </span>
              ) : f.key === 'primary_color' ? (
                'Hex color, e.g. #0f766e'
              ) : undefined
            }
          />
        ))}
      </div>
    </ActionForm>
  );
}

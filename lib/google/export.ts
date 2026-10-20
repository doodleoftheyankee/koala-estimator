// The read-only feed behind the Google Sheets hub (google/apps-script): estimates, jobs with
// planned vs actual hours, and per-area data for the attic visualizer. Flat rows, plain
// numbers and labels, so the spreadsheet needs no parsing. Pure: the route loads the rows.
import { JOB_TYPE_LABELS, TIER_LABELS } from '@/lib/format';
import { PRODUCT_LABELS } from '@/lib/jobs/crew';

type Num = number | string | null;
const n = (v: Num | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const name = (c: { first_name: string; last_name: string } | null) => (c ? `${c.first_name} ${c.last_name}`.trim() : '');

export interface EstimateRow {
  id: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  selected_tier: string | null;
  lost_reason: string | null;
  customer: { first_name: string; last_name: string; phone: string | null; email: string | null } | null;
  property: { street: string; city: string; zip: string } | null;
  estimator: { full_name: string } | null;
  lead: { source: { name: string } | null } | null;
  options: Array<{ tier: string; price: Num }>;
  areas: Array<{ id: string; name: string; job_type: string; sqft: Num; current_r: Num; target_r: Num; access_level: string; removal_needed: boolean }>;
  quotes: Array<{ status: string; signed_price: Num; signed_tier: string | null }>;
}

export interface JobRow {
  id: string;
  status: string;
  scheduled_start: string | null;
  scheduled_days: Num;
  started_at: string | null;
  completed_at: string | null;
  revenue: Num;
  crew: { name: string } | null;
  quote: { signed_tier: string | null; options: unknown } | null;
  estimate: {
    customer: { first_name: string; last_name: string; phone: string | null } | null;
    property: { street: string; city: string; zip: string } | null;
  } | null;
  actuals: Array<{ area_id: string | null; product: string | null; actual_material_qty: Num; actual_hours: Num; verified_at: string | null }>;
}

export interface PricingRefs {
  products: Array<{ code: string; label: string; r_per_inch: Num }>;
  tiers: Array<{ job_type: string; tier: string; label: string; primary_product: string; target_r: Num; include_removal: boolean }>;
  codeMins: Array<{ job_type: string; min_r: Num }>;
}

interface SnapshotLine {
  areaId?: string | null;
  product?: string | null;
  kind?: string;
  qty?: number | null;
  unit?: string | null;
  hours?: number | null;
}

const LOST = new Set(['lost', 'expired', 'void']);
const outcome = (status: string) => (status === 'signed' ? 'Won' : LOST.has(status) ? 'Lost' : status === 'draft' || status === 'ready' ? 'Draft' : 'Open');
const label = (map: Record<string, string>, k: string | null | undefined) => (k ? (map[k] ?? k) : '');

export function buildGoogleExport(args: { estimates: EstimateRow[]; jobs: JobRow[]; refs: PricingRefs; now: Date }) {
  const { refs } = args;
  const estimates = args.estimates.map((e) => {
    const price = (t: string) => n(e.options.find((o) => o.tier === t)?.price);
    const signed = e.quotes.find((q) => q.status === 'signed');
    const c = one(e.customer);
    const p = one(e.property);
    return {
      id: e.id,
      customer: name(c),
      phone: c?.phone ?? '',
      email: c?.email ?? '',
      address: p ? `${p.street}, ${p.city} ${p.zip}` : '',
      city: p?.city ?? '',
      source: one(one(e.lead)?.source)?.name ?? '',
      estimator: one(e.estimator)?.full_name ?? '',
      status: e.status,
      outcome: outcome(e.status),
      created: e.created_at.slice(0, 10),
      decided: e.decided_at?.slice(0, 10) ?? '',
      jobTypes: [...new Set(e.areas.map((a) => label(JOB_TYPE_LABELS, a.job_type)))].join(', '),
      sqft: e.areas.reduce((s, a) => s + (n(a.sqft) ?? 0), 0),
      good: price('good'),
      better: price('better'),
      best: price('best'),
      signedTier: label(TIER_LABELS, signed?.signed_tier),
      signedPrice: n(signed?.signed_price),
      lostReason: e.lost_reason ?? '',
    };
  });

  const jobs = args.jobs.map((j) => {
    const est = one(j.estimate);
    const c = one(est?.customer);
    const p = one(est?.property);
    const q = one(j.quote);
    const option = (Array.isArray(q?.options) ? (q!.options as Array<{ tier?: string; lines?: SnapshotLine[] }>) : []).find((o) => o.tier === q?.signed_tier);
    const lines = option?.lines ?? [];
    const scope = lines
      .filter((l) => l.kind === 'material' && l.product)
      .map((l) => `${label(PRODUCT_LABELS, l.product)} ${Math.round((l.qty ?? 0) * 10) / 10} ${l.unit === 'bag' ? 'bags' : (l.unit ?? '').replace('_', ' ')}`)
      .join('; ');
    const estHours = lines.filter((l) => l.kind === 'labor' || l.kind === 'removal').reduce((s, l) => s + (l.hours ?? 0), 0);
    const actualHours = j.actuals.reduce((s, a) => s + (n(a.actual_hours) ?? 0), 0);
    return {
      id: j.id,
      customer: name(c),
      phone: c?.phone ?? '',
      address: p ? `${p.street}, ${p.city} ${p.zip}` : '',
      crew: one(j.crew)?.name ?? '',
      status: j.status,
      start: j.scheduled_start ?? '',
      days: n(j.scheduled_days),
      signedTier: label(TIER_LABELS, q?.signed_tier),
      revenue: n(j.revenue),
      scope,
      estHours: Math.round(estHours * 10) / 10,
      actualHours: j.actuals.length ? Math.round(actualHours * 10) / 10 : null,
      hoursVariance: j.actuals.length && estHours > 0 ? Math.round(((actualHours - estHours) / estHours) * 1000) / 1000 : null,
      verified: j.actuals.length > 0 && j.actuals.every((a) => a.verified_at !== null),
      completed: j.completed_at?.slice(0, 10) ?? '',
    };
  });

  // Visualizer: per estimate area, what each option installs and to what R-value.
  const product = new Map(refs.products.map((p) => [p.code, p]));
  const codeMin = new Map(refs.codeMins.map((c) => [c.job_type, n(c.min_r)]));
  const areas = args.estimates.flatMap((e) =>
    e.areas.map((a) => ({
      estimateId: e.id,
      customer: name(one(e.customer)),
      area: a.name,
      jobType: a.job_type,
      jobTypeLabel: label(JOB_TYPE_LABELS, a.job_type),
      sqft: n(a.sqft),
      currentR: n(a.current_r) ?? 0,
      access: a.access_level,
      options: (['good', 'better', 'best'] as const).flatMap((tier) => {
        const t = refs.tiers.find((x) => x.job_type === a.job_type && x.tier === tier);
        if (!t) return [];
        const pr = product.get(t.primary_product);
        return [{
          tier: TIER_LABELS[tier],
          label: t.label,
          product: pr?.label ?? t.primary_product,
          rPerInch: n(pr?.r_per_inch ?? null),
          targetR: n(a.target_r) ?? n(t.target_r) ?? codeMin.get(a.job_type) ?? null,
          removesOld: t.include_removal,
          price: n(e.options.find((o) => o.tier === tier)?.price),
        }];
      }),
    })),
  );

  return { generatedAt: args.now.toISOString(), estimates, jobs, areas };
}

import 'server-only';
// Reads for the office jobs pages, through the signed-in user's client (staff RLS), parsed at
// the boundary: numeric columns may arrive as strings, embedded to-one relations as an object or
// a one-item array.
import { z } from 'zod';
import { PRODUCTS } from '@/lib/pricing';
import { PRODUCT_UNITS } from '@/lib/jobs/crew';
import type { OfficeActual } from '@/lib/jobs/office';
import { fetchRows, isHistoryGroup, officeListQueries, uniqueById, type HistoryGroup, type ListQuery } from '@/lib/jobs/officeList';
import { JOB_STATUSES } from '@/lib/jobs/status';
import type { createClient } from '@/lib/supabase/server';

type Db = Awaited<ReturnType<typeof createClient>>;

const one = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (Array.isArray(v) ? (v[0] ?? null) : v), schema.nullable().optional());
const numOrNull = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? null : Number(v)))
  .pipe(z.number().finite().nullable());
const name = one(z.object({ full_name: z.string() }));
const customer = one(z.object({ first_name: z.string(), last_name: z.string(), phone: z.string().nullable().optional(), email: z.string().nullable().optional() }));
const property = one(z.object({ street: z.string(), city: z.string(), zip: z.string() }));

const customerName = (c: z.infer<typeof customer>) => (c ? `${c.first_name} ${c.last_name}`.trim() : '—');
const addressOf = (p: z.infer<typeof property>) => (p ? `${p.street}, ${p.city} ${p.zip}` : '—');

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const listRow = z.object({
  id: z.guid(),
  status: z.enum(JOB_STATUSES),
  scheduled_start: z.string().nullable(),
  scheduled_days: numOrNull,
  completed_at: z.string().nullable(),
  revenue: numOrNull,
  crew: one(z.object({ name: z.string() })),
  quote: one(z.object({ signed_tier: z.string().nullable(), signed_price: numOrNull, doc_options: z.unknown().optional() })),
  estimate: one(z.object({ customer, property })),
  actuals: z.array(z.object({ verified_at: z.string().nullable() })).nullable().optional(),
});

export interface JobListItem {
  id: string;
  status: (typeof JOB_STATUSES)[number];
  customer: string;
  address: string;
  crew: string | null;
  scheduledStart: string | null;
  scheduledDays: number | null;
  completedAt: string | null;
  signedTier: string | null;
  signedPrice: number | null;
  docOptions: unknown;
  actualsCount: number;
  verifiedCount: number;
}

/** The list's select; officeListQueries adds embeds to filter on. */
const LIST_SELECT = `id, status, scheduled_start, scheduled_days, completed_at, revenue,
   crew:crews(name),
   quote:quotes(signed_tier, signed_price, doc_options:snapshot->document->options),
   estimate:estimates(customer:customers(first_name, last_name), property:properties(street, city, zip)),
   actuals:job_actuals(verified_at)`;

export interface JobList {
  jobs: JobListItem[];
  /** History groups cut to their most recent jobs: how many are shown and how many exist. */
  partial: Partial<Record<HistoryGroup, { shown: number; total: number }>>;
  error: string | null;
}

/**
 * Every open job and every completed job awaiting verification, and the latest verified and
 * cancelled jobs (all of `showAll`). One query per group (lib/jobs/officeList.ts); a group that
 * fails to load is reported in `error` and the others are still returned.
 */
export async function loadJobList(db: Db, showAll: HistoryGroup | null = null): Promise<JobList> {
  const queries = officeListQueries(showAll);
  const results = await Promise.all(queries.map((q) => loadListQuery(db, q)));
  const errors = new Set<string>();
  const lists: JobListItem[][] = [];
  const partial: JobList['partial'] = {};
  for (const [i, q] of queries.entries()) {
    const r = results[i]!;
    if ('error' in r) {
      errors.add(r.error);
      continue;
    }
    const parsed = z.array(listRow).safeParse(r.rows);
    if (!parsed.success) {
      errors.add(`Unexpected data from the server (${parsed.error.issues[0]?.message ?? 'parse error'}).`);
      continue;
    }
    lists.push(parsed.data.map(toListItem));
    if (q.limit !== null && isHistoryGroup(q.name) && r.total > parsed.data.length) partial[q.name] = { shown: parsed.data.length, total: r.total };
  }
  return { jobs: uniqueById(lists), partial, error: errors.size ? [...errors].join(' ') : null };
}

async function loadListQuery(db: Db, q: ListQuery): Promise<{ rows: unknown[]; total: number } | { error: string }> {
  try {
    return await fetchRows((from, to) => buildListQuery(db, q).range(from, to), q.limit);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** A list query as a PostgREST query on jobs (staff RLS through the user's client). */
function buildListQuery(db: Db, q: ListQuery) {
  let query = db.from('jobs').select([LIST_SELECT, ...q.embeds].join(', '), { count: 'exact' });
  for (const f of q.filters) {
    if (f.op === 'eq') query = query.eq(f.column, f.value);
    else if (f.op === 'in') query = query.in(f.column, f.values);
    else if (f.op === 'unverifiedRows') query = query.is('unverified.verified_at', null);
    else if (f.op === 'isNull') query = query.is(f.embed, null);
    else query = query.not(f.embed, 'is', null);
  }
  for (const o of q.order) query = query.order(o.column, { ascending: o.ascending, nullsFirst: o.nullsFirst });
  return query;
}

function toListItem(r: z.infer<typeof listRow>): JobListItem {
  return {
    id: r.id,
    status: r.status,
    customer: customerName(r.estimate?.customer),
    address: addressOf(r.estimate?.property),
    crew: r.crew?.name ?? null,
    scheduledStart: r.scheduled_start,
    scheduledDays: r.scheduled_days,
    completedAt: r.completed_at,
    signedTier: r.quote?.signed_tier ?? null,
    signedPrice: r.quote?.signed_price ?? r.revenue,
    docOptions: r.quote?.doc_options ?? null,
    actualsCount: r.actuals?.length ?? 0,
    verifiedCount: (r.actuals ?? []).filter((a) => a.verified_at !== null).length,
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const detailRow = z.object({
  id: z.guid(),
  status: z.enum(JOB_STATUSES),
  scheduled_start: z.string().nullable(),
  scheduled_days: numOrNull,
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  revenue: numOrNull,
  crew_id: z.guid().nullable(),
  quote: one(
    z.object({
      id: z.guid(),
      version: z.coerce.number(),
      signed_tier: z.string().nullable(),
      signed_price: numOrNull,
      signed_at: z.string().nullable(),
      snapshot: z.unknown(),
    }),
  ),
  estimate: one(
    z.object({
      id: z.guid(),
      drive_minutes_est: numOrNull,
      estimator: name,
      customer,
      property,
      areas: z
        .array(z.object({ id: z.guid(), name: z.string(), job_type: z.string(), sqft: numOrNull, sort_order: numOrNull }))
        .nullable()
        .optional(),
    }),
  ),
});

const actualRow = z.object({
  id: z.guid(),
  area_id: z.guid().nullable(),
  product: z.enum(PRODUCTS).nullable(),
  actual_material_qty: numOrNull,
  actual_material_unit: z.enum(PRODUCT_UNITS).nullable(),
  actual_hours: numOrNull,
  actual_crew_size: numOrNull,
  actual_drive_minutes: numOrNull,
  actual_days: numOrNull,
  actual_material_cost: numOrNull,
  actual_labor_cost: numOrNull,
  actual_other_cost: numOrNull,
  notes: z.string().nullable(),
  entered_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  exclude_from_learning: z.boolean(),
  exclude_reason: z.string().nullable(),
  entered: name,
  verifier: name,
});

export interface JobDetail {
  id: string;
  status: (typeof JOB_STATUSES)[number];
  scheduledStart: string | null;
  scheduledDays: number | null;
  startedAt: string | null;
  completedAt: string | null;
  revenue: number | null;
  crewId: string | null;
  quote: { id: string; version: number; signedTier: string | null; signedPrice: number | null; signedAt: string | null; snapshot: unknown } | null;
  estimateId: string | null;
  driveMinutesEst: number | null;
  estimator: string | null;
  customer: { name: string; phone: string | null; email: string | null };
  address: string;
  areas: Array<{ id: string; name: string; jobType: string; sqft: number | null }>;
  actuals: OfficeActual[];
}

export async function loadJob(db: Db, id: string): Promise<{ job: JobDetail | null; error: string | null }> {
  const [jobRes, actualsRes] = await Promise.all([
    db
      .from('jobs')
      .select(
        `id, status, scheduled_start, scheduled_days, started_at, completed_at, revenue, crew_id,
         quote:quotes(id, version, signed_tier, signed_price, signed_at, snapshot),
         estimate:estimates(id, drive_minutes_est,
           estimator:profiles!estimates_estimator_id_fkey(full_name),
           customer:customers(first_name, last_name, phone, email),
           property:properties(street, city, zip),
           areas:estimate_areas(id, name, job_type, sqft, sort_order))`,
      )
      .eq('id', id)
      .maybeSingle(),
    db
      .from('job_actuals')
      .select(
        `id, area_id, product, actual_material_qty, actual_material_unit, actual_hours, actual_crew_size, actual_drive_minutes,
         actual_days, actual_material_cost, actual_labor_cost, actual_other_cost, notes, entered_at, verified_at,
         exclude_from_learning, exclude_reason,
         entered:profiles!job_actuals_entered_by_fkey(full_name),
         verifier:profiles!job_actuals_verified_by_fkey(full_name)`,
      )
      .eq('job_id', id)
      .order('entered_at'),
  ]);
  if (jobRes.error) return { job: null, error: jobRes.error.message };
  if (!jobRes.data) return { job: null, error: null };
  if (actualsRes.error) return { job: null, error: actualsRes.error.message };
  const j = detailRow.safeParse(jobRes.data);
  const a = z.array(actualRow).safeParse(actualsRes.data);
  if (!j.success || !a.success) {
    const issue = (j.success ? null : j.error.issues[0]) ?? (a.success ? null : a.error.issues[0]);
    return { job: null, error: `Unexpected data from the server (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'parse error'}).` };
  }
  const r = j.data;
  const est = r.estimate;
  return {
    error: null,
    job: {
      id: r.id,
      status: r.status,
      scheduledStart: r.scheduled_start,
      scheduledDays: r.scheduled_days,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      revenue: r.revenue,
      crewId: r.crew_id,
      quote: r.quote
        ? { id: r.quote.id, version: r.quote.version, signedTier: r.quote.signed_tier, signedPrice: r.quote.signed_price, signedAt: r.quote.signed_at, snapshot: r.quote.snapshot }
        : null,
      estimateId: est?.id ?? null,
      driveMinutesEst: est?.drive_minutes_est ?? null,
      estimator: est?.estimator?.full_name ?? null,
      customer: { name: customerName(est?.customer), phone: est?.customer?.phone ?? null, email: est?.customer?.email ?? null },
      address: addressOf(est?.property),
      areas: [...(est?.areas ?? [])]
        .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
        .map((x) => ({ id: x.id, name: x.name, jobType: x.job_type, sqft: x.sqft })),
      actuals: a.data.map((x) => ({
        id: x.id,
        areaId: x.area_id,
        product: x.product,
        materialQty: x.actual_material_qty,
        materialUnit: x.actual_material_unit,
        hours: x.actual_hours,
        crewSize: x.actual_crew_size,
        driveMinutes: x.actual_drive_minutes,
        days: x.actual_days,
        materialCost: x.actual_material_cost,
        laborCost: x.actual_labor_cost,
        otherCost: x.actual_other_cost,
        notes: x.notes,
        enteredBy: x.entered?.full_name ?? null,
        enteredAt: x.entered_at,
        verifiedBy: x.verifier?.full_name ?? null,
        verifiedAt: x.verified_at,
        excluded: x.exclude_from_learning,
        excludeReason: x.exclude_reason,
      })),
    },
  };
}

export async function loadCrews(db: Db): Promise<Array<{ id: string; name: string; active: boolean }>> {
  const res = await db.from('crews').select('id, name, active').order('name');
  const parsed = z.array(z.object({ id: z.guid(), name: z.string(), active: z.boolean() })).safeParse(res.data ?? []);
  return parsed.success ? parsed.data : [];
}

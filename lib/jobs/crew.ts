// The crew app's wire format (GET /api/crew/jobs, POST /api/crew/actuals) and the parsing of
// crew_job_view rows into jobs. Shared by the server and the phone. Nothing here carries a
// price, cost or margin: crews never see money (PLAN.md §3). Pure.
import { z } from 'zod';
import { ACCESS_LEVELS, JOB_TYPES, PRODUCTS, type ProductCode, type ProductUnit } from '@/lib/pricing';
import { JOB_STATUSES } from './status';

export const PRODUCT_UNITS = ['board_ft', 'bag', 'sqft', 'linear_ft', 'hour', 'each'] as const satisfies readonly ProductUnit[];

export const PRODUCT_LABELS: Record<ProductCode, string> = {
  ocsf: 'Open-cell spray foam',
  ccsf: 'Closed-cell spray foam',
  cellulose: 'Cellulose',
  fiberglass_blown: 'Blown fiberglass',
  batts: 'Fiberglass batts',
  air_sealing: 'Air sealing',
  removal: 'Removal of old insulation',
};

/** Plural unit names for quantities ("70 bags"). */
export const UNIT_LABELS: Record<ProductUnit, string> = {
  board_ft: 'board ft',
  bag: 'bags',
  sqft: 'sq ft',
  linear_ft: 'linear ft',
  hour: 'hours',
  each: 'each',
};

// Numeric columns can arrive as JSON numbers or strings (Postgres numeric).
const num = z.union([z.number(), z.string().trim().min(1)]).transform(Number).pipe(z.number().finite());
const numOrNull = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? null : Number(v)))
  .pipe(z.number().finite().nullable());
const textOrNull = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v === undefined || v === null || v.trim() === '' ? null : v));

// ---------------------------------------------------------------------------
// GET /api/crew/jobs
// ---------------------------------------------------------------------------

export const SCOPE_KINDS = ['material', 'labor', 'removal'] as const;

/** One line of the signed option for an area: what to install and the planned hours. */
export const scopeLineSchema = z.object({
  product: z.enum(PRODUCTS),
  kind: z.enum(SCOPE_KINDS),
  description: z.string(),
  qty: numOrNull,
  unit: z.enum(PRODUCT_UNITS).nullable().optional().transform((v) => v ?? null),
  hours: numOrNull,
});
export type ScopeLine = z.infer<typeof scopeLineSchema>;

export const crewAreaSchema = z.object({
  areaId: z.guid(),
  name: z.string(),
  jobType: z.enum(JOB_TYPES),
  sqft: z.number().finite(),
  accessLevel: z.enum(ACCESS_LEVELS),
  removalNeeded: z.boolean(),
  prepNotes: z.string().nullable(),
  hazards: z.array(z.string()),
  hazardDisposition: z.string().nullable(),
  scope: z.array(scopeLineSchema),
});
export type CrewArea = z.infer<typeof crewAreaSchema>;

/** A job_actuals row as the crew may see it: quantities and hours only, never costs. */
export const serverActualSchema = z.object({
  id: z.guid(),
  areaId: z.guid().nullable(),
  product: z.enum(PRODUCTS).nullable(),
  materialQty: z.number().finite().nullable(),
  materialUnit: z.enum(PRODUCT_UNITS).nullable(),
  hours: z.number().finite().nullable(),
  crewSize: z.number().finite().nullable(),
  driveMinutes: z.number().finite().nullable(),
  days: z.number().finite().nullable(),
  notes: z.string().nullable(),
  enteredAt: z.string().nullable(),
  /** Bumped on every server-side change; the phone sends back the version its edit is based on. */
  rowVersion: z.number().int(),
});
export type ServerActual = z.infer<typeof serverActualSchema>;

export const crewJobSchema = z.object({
  jobId: z.guid(),
  status: z.enum(JOB_STATUSES),
  scheduledStart: z.string().nullable(), // YYYY-MM-DD (a date column)
  scheduledDays: z.number().finite().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  address: z.object({
    street: z.string(),
    city: z.string(),
    zip: z.string(),
    lat: z.number().finite().nullable(),
    lng: z.number().finite().nullable(),
  }),
  customer: z.object({ name: z.string(), phone: z.string().nullable() }),
  signedTier: z.string().nullable(),
  areas: z.array(crewAreaSchema),
  actuals: z.array(serverActualSchema),
  /** The office verified the actuals: the crew can no longer change them. */
  verified: z.boolean(),
});
export type CrewJob = z.infer<typeof crewJobSchema>;

export const crewJobsResponseSchema = z.object({ jobs: z.array(crewJobSchema), fetchedAt: z.string() });
export type CrewJobsResponse = z.infer<typeof crewJobsResponseSchema>;

/** Columns read from crew_job_view (no money columns exist there). */
export const CREW_VIEW_COLUMNS =
  'job_id, status, scheduled_start, scheduled_days, started_at, completed_at, street, city, zip, lat, lng, first_name, last_name, phone, ' +
  'area_id, area_name, job_type, sqft, access_level, removal_needed, prep_notes, hazards, hazard_disposition, area_sort, signed_tier, scope';

export const crewViewRowSchema = z.object({
  job_id: z.guid(),
  status: z.enum(JOB_STATUSES),
  scheduled_start: textOrNull,
  scheduled_days: numOrNull,
  started_at: textOrNull,
  completed_at: textOrNull,
  street: z.string(),
  city: z.string(),
  zip: z.string(),
  lat: numOrNull,
  lng: numOrNull,
  first_name: z.string(),
  last_name: z.string(),
  phone: textOrNull,
  area_id: z.guid(),
  area_name: z.string(),
  job_type: z.enum(JOB_TYPES),
  sqft: num,
  access_level: z.enum(ACCESS_LEVELS),
  removal_needed: z.boolean(),
  prep_notes: textOrNull,
  hazards: z.array(z.string()).nullable().optional().transform((v) => v ?? []),
  hazard_disposition: textOrNull,
  area_sort: numOrNull,
  signed_tier: textOrNull,
  // Lines without a product cannot be matched to actuals; drop them rather than fail the job.
  scope: z
    .array(z.unknown())
    .nullable()
    .optional()
    .transform((v) => (v ?? []).flatMap((l) => {
      const r = scopeLineSchema.safeParse(l);
      return r.success ? [r.data] : [];
    })),
});
export type CrewViewRow = z.infer<typeof crewViewRowSchema>;

/** Columns of crew_actuals_view the crew app reads (the view has no cost columns at all). */
export const CREW_ACTUAL_COLUMNS =
  'id, job_id, area_id, product, actual_material_qty, actual_material_unit, actual_hours, actual_crew_size, actual_drive_minutes, actual_days, notes, entered_at, verified_at, row_version';

export const actualDbRowSchema = z.object({
  id: z.guid(),
  job_id: z.guid(),
  area_id: z.guid().nullable(),
  product: z.enum(PRODUCTS).nullable(),
  actual_material_qty: numOrNull,
  actual_material_unit: z.enum(PRODUCT_UNITS).nullable(),
  actual_hours: numOrNull,
  actual_crew_size: numOrNull,
  actual_drive_minutes: numOrNull,
  actual_days: numOrNull,
  notes: textOrNull,
  entered_at: textOrNull,
  verified_at: textOrNull,
  row_version: num.pipe(z.number().int()),
});
export type ActualDbRow = z.infer<typeof actualDbRowSchema>;

export function toServerActual(r: Omit<ActualDbRow, 'job_id' | 'verified_at'>): ServerActual {
  return {
    id: r.id,
    areaId: r.area_id,
    product: r.product,
    materialQty: r.actual_material_qty,
    materialUnit: r.actual_material_unit,
    hours: r.actual_hours,
    crewSize: r.actual_crew_size,
    driveMinutes: r.actual_drive_minutes,
    days: r.actual_days,
    notes: r.notes,
    enteredAt: r.entered_at,
    rowVersion: r.row_version,
  };
}

/**
 * crew_job_view has one row per job area; groups them back into jobs (first-seen order) with
 * areas in estimate order. Actuals and the verified flag are attached by the caller.
 */
export function groupViewRows(rows: readonly CrewViewRow[]): Array<Omit<CrewJob, 'actuals' | 'verified'>> {
  const jobs = new Map<string, Omit<CrewJob, 'actuals' | 'verified'> & { sorts: Map<string, number> }>();
  for (const r of rows) {
    let job = jobs.get(r.job_id);
    if (!job) {
      job = {
        jobId: r.job_id,
        status: r.status,
        scheduledStart: r.scheduled_start,
        scheduledDays: r.scheduled_days,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        address: { street: r.street, city: r.city, zip: r.zip, lat: r.lat, lng: r.lng },
        customer: { name: `${r.first_name} ${r.last_name}`.trim(), phone: r.phone },
        signedTier: r.signed_tier,
        areas: [],
        sorts: new Map(),
      };
      jobs.set(r.job_id, job);
    }
    if (job.areas.some((a) => a.areaId === r.area_id)) continue;
    job.sorts.set(r.area_id, r.area_sort ?? 0);
    job.areas.push({
      areaId: r.area_id,
      name: r.area_name,
      jobType: r.job_type,
      sqft: r.sqft,
      accessLevel: r.access_level,
      removalNeeded: r.removal_needed,
      prepNotes: r.prep_notes,
      hazards: r.hazards,
      hazardDisposition: r.hazard_disposition,
      scope: r.scope,
    });
  }
  return [...jobs.values()].map(({ sorts, ...job }) => ({
    ...job,
    areas: [...job.areas].sort((a, b) => (sorts.get(a.areaId) ?? 0) - (sorts.get(b.areaId) ?? 0)),
  }));
}

// ---------------------------------------------------------------------------
// POST /api/crew/actuals
// ---------------------------------------------------------------------------

/** One actuals row as the phone sends it. Area + product, or neither (the job-level row). */
export const actualsRowSchema = z
  .object({
    id: z.guid(),
    areaId: z.guid().nullable(),
    product: z.enum(PRODUCTS).nullable(),
    materialQty: z.number().finite().min(0).max(1_000_000).nullable(),
    materialUnit: z.enum(PRODUCT_UNITS).nullable(),
    hours: z.number().finite().min(0).max(10_000).nullable(),
    crewSize: z.number().int().min(1).max(20).nullable(),
    driveMinutes: z.number().finite().min(0).max(600).nullable(),
    days: z.number().finite().min(0).max(365).nullable(),
    notes: z.string().trim().max(2000).nullable(),
    /** The server row_version this edit is based on; null when the phone has not seen the row. */
    baseVersion: z.number().int().min(1).nullable(),
  })
  .refine((r) => (r.areaId === null) === (r.product === null), { message: 'Area and product go together (or neither, for the job row)' });
export type ActualsRow = z.infer<typeof actualsRowSchema>;

export const actualsBodySchema = z
  .object({
    mutationId: z.guid(),
    jobId: z.guid(),
    rows: z.array(actualsRowSchema).max(200),
  })
  .refine((b) => new Set(b.rows.map((r) => naturalKey(r.areaId, r.product))).size === b.rows.length, {
    message: 'Each area and product appears once',
  })
  .refine((b) => new Set(b.rows.map((r) => r.id)).size === b.rows.length, { message: 'Row ids must be unique' });
export type ActualsBody = z.infer<typeof actualsBodySchema>;

/** A row the server wrote, with its new version. */
export const savedActualSchema = z.object({
  id: z.guid(),
  areaId: z.guid().nullable(),
  product: z.enum(PRODUCTS).nullable(),
  rowVersion: z.number().int(),
});
export type SavedActual = z.infer<typeof savedActualSchema>;

/**
 * 'applied': rows written (saved) and rows that changed on the server since the phone's base
 * (conflicts, with the server's values: nothing was written for them; the phone merges and
 * re-sends). 'conflict': two phones created the same row at the same moment; pull and retry.
 * 'rejected': the mutation id was already used by another user on this phone; send again under
 * a new id.
 */
export type ActualsSyncResponse =
  | { status: 'applied'; rows: number; saved: SavedActual[]; conflicts: ServerActual[] }
  | { status: 'locked' | 'conflict' | 'invalid' | 'error' | 'rejected'; error: string };

export const LOCKED_MESSAGE = 'The office already verified this job. Actuals can no longer be changed from the crew app.';

/** Same identity the database uses: unique (job_id, area_id, product), nulls not distinct. */
export function naturalKey(areaId: string | null, product: ProductCode | null): string {
  return areaId === null || product === null ? 'job' : `${areaId}|${product}`;
}

/** Wire row -> sync_job_actuals row (job_actuals column names). Costs are never sent by the crew. */
export function toDbActualRow(r: ActualsRow): Record<string, string | number | null> {
  return {
    id: r.id,
    area_id: r.areaId,
    product: r.product,
    actual_material_qty: r.materialQty,
    actual_material_unit: r.materialQty === null ? null : r.materialUnit,
    actual_hours: r.hours,
    actual_crew_size: r.crewSize,
    actual_drive_minutes: r.driveMinutes,
    actual_days: r.days,
    notes: r.notes === null || r.notes === '' ? null : r.notes,
    base_row_version: r.baseVersion,
  };
}

/** sync_job_actuals' answer (snake_case jsonb) -> the wire response. */
const dbSavedSchema = z.object({ id: z.guid(), area_id: z.guid().nullable(), product: z.enum(PRODUCTS).nullable(), row_version: z.number().int() });
export const syncActualsResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    rows: z.number(),
    saved: z.array(dbSavedSchema),
    conflicts: z.array(actualDbRowSchema.omit({ job_id: true, verified_at: true }).extend({ entered_at: textOrNull })),
  }),
  z.object({ status: z.literal('locked') }),
  z.object({ status: z.literal('rejected'), error: z.string() }),
]);

export function fromSyncResult(r: z.infer<typeof syncActualsResultSchema>): ActualsSyncResponse {
  switch (r.status) {
    case 'applied':
      return {
        status: 'applied',
        rows: r.rows,
        saved: r.saved.map((x) => ({ id: x.id, areaId: x.area_id, product: x.product, rowVersion: x.row_version })),
        conflicts: r.conflicts.map(toServerActual),
      };
    case 'locked':
      return { status: 'locked', error: LOCKED_MESSAGE };
    case 'rejected':
      return { status: 'rejected', error: r.error };
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Maps search link: coordinates when geocoded, else the address. */
export function mapsUrl(address: CrewJob['address']): string {
  const q =
    address.lat !== null && address.lng !== null
      ? `${address.lat},${address.lng}`
      : `${address.street}, ${address.city} ${address.zip}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** tel: link with only dialable characters, or null. */
export function telUrl(phone: string | null): string | null {
  const digits = (phone ?? '').replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 ? `tel:${digits}` : null;
}

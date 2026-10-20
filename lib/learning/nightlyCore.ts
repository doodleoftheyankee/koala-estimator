// The nightly learning job without its database (PLAN.md §6.4): row parsing at the database
// boundary, which jobs/quotes/flags feed learning, the four isolated steps run over injected
// I/O (NightlyDeps), and the owner's failure notice. nightly.ts wires in lib/learning/io.ts.
// No network, no clock: everything impure comes in through NightlyDeps, so it is unit tested.
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ACCESS_LEVELS,
  COEFF_KINDS,
  JOB_TYPES,
  lineKey,
  PRODUCTS,
  TIERS,
  type PricedOption,
  type ProductCode,
  type WinModel,
} from '@/lib/pricing';
import { estimateAccuracy } from './accuracy';
import { calibrate as realCalibrate } from './calibrate';
import { deviationOutcome } from './deviation';
import type { NightlySummary } from './nightly';
import {
  observationsFromJob,
  winObservationFromQuote,
  type ActualRow,
  type JobForLearning,
  type QuoteOutcomeRow,
} from './observations';
import type {
  CalibrationInput,
  CalibrationResult,
  CandidateCoefficient,
  DeviationOutcome,
  DriveObservation,
  LearningSettings,
  Observation,
  QuoteSnapshotForLearning,
  StoredCoefficient,
  WinObservation,
} from './types';
import { trainWinModel, winRateBuckets } from './winRate';

/** A 'running' learning run older than this never finished (the function timed out or crashed). */
export const STALE_RUN_MS = 15 * 60_000;
/** Business dates (email subjects) are Newark, DE dates. */
const BUSINESS_TZ = 'America/New_York';

// ---------------------------------------------------------------------------
// Row parsing (PostgREST returns numeric columns as numbers or strings)
// ---------------------------------------------------------------------------

const numeric = z.union([z.number(), z.string().trim().min(1)]).transform(Number).pipe(z.number());
const numericOrNull = numeric.nullable();
const id = z.string().min(1);

export const activeSetRowSchema = z.object({ id, version: numeric });

export const coefficientRowSchema = z.object({
  kind: z.enum(COEFF_KINDS),
  product: z.enum(PRODUCTS).nullable(),
  job_type: z.enum(JOB_TYPES).nullable(),
  access_level: z.enum(ACCESS_LEVELS).nullable(),
  value: numeric,
  prior_value: numeric,
  lower_bound: numeric,
  upper_bound: numeric,
  sample_size: numeric,
  n_eff: numeric,
  confidence: numeric,
});
export type CoefficientRow = z.infer<typeof coefficientRowSchema>;

export const jobRowSchema = z.object({ id, quote_id: id, estimate_id: id, completed_at: z.string().nullable() });
export type JobRow = z.infer<typeof jobRowSchema>;

export const actualDbRowSchema = z.object({
  job_id: id,
  area_id: z.string().nullable(),
  product: z.enum(PRODUCTS).nullable(),
  actual_material_qty: numericOrNull,
  actual_hours: numericOrNull,
  actual_drive_minutes: numericOrNull,
  verified_at: z.string().nullable(),
  exclude_from_learning: z.boolean(),
});
export type ActualDbRow = z.infer<typeof actualDbRowSchema>;

export const learningQuoteRowSchema = z.object({ id, signed_tier: z.enum(TIERS).nullable(), snapshot: z.unknown() });
export type LearningQuoteRow = z.infer<typeof learningQuoteRowSchema>;

export const areaRowSchema = z.object({
  id,
  estimate_id: id,
  name: z.string(),
  job_type: z.enum(JOB_TYPES),
  access_level: z.enum(ACCESS_LEVELS),
  sqft: numeric,
});
export type AreaRow = z.infer<typeof areaRowSchema>;

export const estimateDriveRowSchema = z.object({ id, drive_minutes_est: numericOrNull });
export type EstimateDriveRow = z.infer<typeof estimateDriveRowSchema>;

export const outcomeQuoteRowSchema = z.object({
  id,
  estimate_id: id,
  version: numeric,
  status: z.string(),
  signed_at: z.string().nullable(),
  signed_tier: z.enum(TIERS).nullable(),
  expires_at: z.string(),
});
export type OutcomeQuoteRow = z.infer<typeof outcomeQuoteRowSchema>;

export const outcomeEstimateRowSchema = z.object({
  id,
  status: z.string(),
  decided_at: z.string().nullable(),
  lead_id: z.string().nullable(),
});
export type OutcomeEstimateRow = z.infer<typeof outcomeEstimateRowSchema>;

export const leadRowSchema = z.object({ id, source_id: z.string().nullable() });
export const leadSourceRowSchema = z.object({ id, name: z.string() });

// No estimator_value/model_value: outcomes are scored from the signed quote (see lineFlagOutcomes).
export const flagRowSchema = z.object({ id, estimate_id: id, flag_key: z.string().nullable(), metric: z.string() });
export type FlagRow = z.infer<typeof flagRowSchema>;

/** A signed quote with only its frozen options (selected as `options:snapshot->options`). */
export const flagQuoteRowSchema = z.object({ id, signed_tier: z.enum(TIERS).nullable(), options: z.unknown() });
export type FlagQuoteRow = z.infer<typeof flagQuoteRowSchema>;

export const idRowSchema = z.object({ id });

/** Parses every row or throws naming the table and the first problem. */
export function parseRows<T>(schema: z.ZodType<T>, rows: readonly unknown[], what: string): T[] {
  return rows.map((row, i) => {
    const r = schema.safeParse(row);
    if (!r.success) {
      const issue = r.error.issues[0];
      const where = issue && issue.path.length ? ` (${issue.path.join('.')})` : '';
      throw new Error(`Unexpected ${what} row #${i + 1}${where}: ${issue?.message ?? 'invalid'}`);
    }
    return r.data;
  });
}

export function toStoredCoefficient(r: CoefficientRow): StoredCoefficient {
  return {
    kind: r.kind,
    product: r.product,
    jobType: r.job_type,
    accessLevel: r.access_level,
    value: r.value,
    priorValue: r.prior_value,
    lowerBound: r.lower_bound,
    upperBound: r.upper_bound,
    sampleSize: r.sample_size,
    nEff: r.n_eff,
    confidence: r.confidence,
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quote snapshots (jsonb written by app/api/quotes; older versions lack fields)
// ---------------------------------------------------------------------------

const snapshotLineSchema = z.looseObject({
  kind: z.string(),
  areaId: z.string().nullish(),
  product: z.string().nullish(),
});
const learningOptionSchema = z.looseObject({ tier: z.enum(TIERS), lines: z.array(snapshotLineSchema) });
const outcomeOptionSchema = z.looseObject({ tier: z.enum(TIERS) });
const snapshotInputSchema = z.object({
  areas: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      jobType: z.enum(JOB_TYPES),
      accessLevel: z.enum(ACCESS_LEVELS),
      sqft: z.number(),
    }),
  ),
  driveMinutesOneWay: z.number().nullable(),
});
const recommendedSchema = z.object({ recommendedTier: z.enum(TIERS).nullable() });

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The parts of quotes.snapshot the calibration reads. Unusable options become [] (the job then
 * yields no observations) and an unusable `input` is dropped (estimate_areas is the fallback).
 */
export function parseLearningSnapshot(raw: unknown): QuoteSnapshotForLearning {
  const s = asRecord(raw);
  const options = z.array(learningOptionSchema).safeParse(s.options);
  const input = snapshotInputSchema.safeParse(s.input);
  return {
    // Checked above for every field observations.ts dereferences; the rest it reads defensively.
    options: options.success ? (options.data as unknown as PricedOption[]) : [],
    ...(input.success ? { input: input.data } : {}),
  };
}

/** The parts of quotes.snapshot the win model reads (see winObservationFromQuote). */
export function parseOutcomeSnapshot(raw: unknown): QuoteOutcomeRow['snapshot'] {
  const s = asRecord(raw);
  const options = z.array(outcomeOptionSchema).safeParse(s.options);
  const input = snapshotInputSchema.safeParse(s.input);
  const document = recommendedSchema.safeParse(s.document);
  return {
    ...(document.success ? { document: document.data } : {}),
    ...(options.success ? { options: options.data as unknown as PricedOption[] } : {}),
    ...(input.success ? { input: input.data } : {}),
  };
}

// ---------------------------------------------------------------------------
// Which jobs feed calibration
// ---------------------------------------------------------------------------

/** Jobs whose actuals are complete: at least one row and every row verified (jobId -> rows). */
export function verifiedActualsByJob(actuals: readonly ActualDbRow[]): Map<string, ActualDbRow[]> {
  const out = new Map<string, ActualDbRow[]>();
  for (const [jobId, rows] of groupBy(actuals, (a) => a.job_id)) {
    if (rows.every((r) => r.verified_at !== null)) out.set(jobId, rows);
  }
  return out;
}

export interface LearningRows {
  jobs: JobRow[];
  actuals: ActualDbRow[];
  quotes: LearningQuoteRow[];
  areas: AreaRow[];
  estimates: EstimateDriveRow[];
}

const toActualRow = (r: ActualDbRow): ActualRow => ({
  areaId: r.area_id,
  product: r.product,
  actualMaterialQty: r.actual_material_qty,
  actualHours: r.actual_hours,
  actualDriveMinutes: r.actual_drive_minutes,
});

/** Epoch ms of an ISO timestamp; missing or unparseable sorts first (-Infinity). */
function timeMs(iso: string | null): number {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Latest of a list of ISO timestamps, or null when none parses. */
function latest(isos: Array<string | null>): string | null {
  let best: string | null = null;
  for (const s of isos) if (timeMs(s) > timeMs(best)) best = s;
  return best;
}

/**
 * Completed jobs with fully verified actuals, as observations.ts consumes them. Excluded actuals
 * (callbacks, rework) are dropped but the job still counts as considered. A job without its
 * quote or signed tier cannot be attributed to a priced option and is skipped. Sorted by
 * completion time, then id, so runs are reproducible.
 */
export function assembleJobsForLearning(rows: LearningRows): JobForLearning[] {
  const actuals = verifiedActualsByJob(rows.actuals);
  const quotes = new Map(rows.quotes.map((q) => [q.id, q]));
  const areas = groupBy(rows.areas, (a) => a.estimate_id);
  const drive = new Map(rows.estimates.map((e) => [e.id, e.drive_minutes_est]));

  const out: JobForLearning[] = [];
  for (const job of rows.jobs) {
    const jobActuals = actuals.get(job.id);
    const quote = quotes.get(job.quote_id);
    if (!jobActuals || !quote || !quote.signed_tier) continue;
    // A job closed without the crew's status button has no completed_at; verification time is next best.
    const completedAt = job.completed_at ?? latest(jobActuals.map((a) => a.verified_at));
    if (completedAt === null) continue;
    out.push({
      jobId: job.id,
      completedAt,
      signedTier: quote.signed_tier,
      snapshot: parseLearningSnapshot(quote.snapshot),
      areasFallback: (areas.get(job.estimate_id) ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        jobType: a.job_type,
        accessLevel: a.access_level,
        sqft: a.sqft,
      })),
      actuals: jobActuals.filter((a) => !a.exclude_from_learning).map(toActualRow),
      driveMinutesEstFallback: drive.get(job.estimate_id) ?? null,
    });
  }
  return out.sort((a, b) => timeMs(a.completedAt) - timeMs(b.completedAt) || (a.jobId < b.jobId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Which quotes feed the win model
// ---------------------------------------------------------------------------

export interface DecidedEstimate {
  estimateId: string;
  /** The quote whose snapshot describes the decision: the signed one for wins, else the latest. */
  quoteId: string;
  won: boolean;
  decidedAt: string;
  source: string | null;
  signedTier: QuoteOutcomeRow['signedTier'];
}

export interface OutcomeRows {
  quotes: OutcomeQuoteRow[];
  estimates: OutcomeEstimateRow[];
  leads: Array<z.infer<typeof leadRowSchema>>;
  sources: Array<z.infer<typeof leadSourceRowSchema>>;
}

const byVersionDesc = (a: OutcomeQuoteRow, b: OutcomeQuoteRow) => b.version - a.version;

/**
 * One row per estimate with at least one quote, when it is decided: won (any version signed),
 * lost (estimates.status = 'lost') or its latest version expired/declined. Undecided estimates
 * and voided ones that were never signed (not a customer's decision) are left out.
 * decidedAt: signed_at for wins, else estimates.decided_at, else the latest quote's expiry.
 */
export function decideEstimates(rows: OutcomeRows): DecidedEstimate[] {
  const estimates = new Map(rows.estimates.map((e) => [e.id, e]));
  const leadSource = new Map(rows.leads.map((l) => [l.id, l.source_id]));
  const sourceName = new Map(rows.sources.map((s) => [s.id, s.name]));

  const out: DecidedEstimate[] = [];
  for (const [estimateId, versions] of groupBy(rows.quotes, (q) => q.estimate_id)) {
    const sorted = [...versions].sort(byVersionDesc);
    const newest = sorted[0]!;
    const signed = sorted.find((q) => q.status === 'signed') ?? null;
    const est = estimates.get(estimateId) ?? null;
    if (!signed && est?.status === 'void') continue;
    const decided = signed !== null || est?.status === 'lost' || newest.status === 'expired' || newest.status === 'declined';
    if (!decided) continue;

    const sourceId = est?.lead_id ? (leadSource.get(est.lead_id) ?? null) : null;
    out.push({
      estimateId,
      quoteId: (signed ?? newest).id,
      won: signed !== null,
      decidedAt: signed?.signed_at ?? est?.decided_at ?? newest.expires_at,
      source: sourceId ? (sourceName.get(sourceId) ?? null) : null,
      signedTier: signed?.signed_tier ?? null,
    });
  }
  return out.sort((a, b) => (a.estimateId < b.estimateId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Deviation flag outcomes (PLAN.md §6.5: did the estimator or the model call it?)
// ---------------------------------------------------------------------------

const LINE_KINDS = ['material', 'labor', 'removal'] as const;
const PRODUCT_SET: ReadonlySet<string> = new Set(PRODUCTS);

export interface LineFlagKey {
  areaId: string;
  product: ProductCode;
  kind: (typeof LINE_KINDS)[number];
  metric: 'qty' | 'hours';
}

/** `${areaId}|${product}|${kind}|${metric}` (lineKey + metric), or null for total/legacy flags. */
export function parseLineFlagKey(key: string | null): LineFlagKey | null {
  if (!key) return null;
  const parts = key.split('|');
  if (parts.length !== 4) return null;
  const [areaId, product, kind, metric] = parts as [string, string, string, string];
  if (!areaId || !PRODUCT_SET.has(product)) return null;
  if (!(LINE_KINDS as readonly string[]).includes(kind)) return null;
  if (metric !== 'qty' && metric !== 'hours') return null;
  // Quantities live on material lines; hours on labor/removal lines.
  if ((metric === 'qty') !== (kind === 'material')) return null;
  return { areaId, product: product as ProductCode, kind: kind as LineFlagKey['kind'], metric };
}

/** A line flag whose job is done, with the crew's actual it is judged against. */
export interface ScorableLineFlag {
  id: string;
  /** The job's signed quote: its snapshot holds the numbers the customer agreed to. */
  quoteId: string;
  lineKey: string;
  metric: 'qty' | 'hours';
  actual: number;
}

/**
 * Unresolved line flags whose estimate has a completed job with fully verified actuals (the most
 * recently completed one if several) and a usable actual for the flag's area x product (material
 * qty for 'qty', person-hours for 'hours'). Total-price flags, excluded actuals and missing or
 * non-positive actuals are left out, so their quotes are never loaded.
 */
export function scorableLineFlags(
  flags: readonly FlagRow[],
  jobs: readonly JobRow[],
  actuals: readonly ActualDbRow[],
): ScorableLineFlag[] {
  const verified = verifiedActualsByJob(actuals);
  const jobByEstimate = new Map<string, JobRow>();
  const newestFirst = jobs
    .filter((j) => verified.has(j.id))
    .sort((a, b) => timeMs(b.completed_at) - timeMs(a.completed_at) || (a.id < b.id ? 1 : -1));
  for (const job of newestFirst) if (!jobByEstimate.has(job.estimate_id)) jobByEstimate.set(job.estimate_id, job);

  const out: ScorableLineFlag[] = [];
  for (const flag of flags) {
    const key = parseLineFlagKey(flag.flag_key);
    if (!key || key.metric !== flag.metric) continue;
    const job = jobByEstimate.get(flag.estimate_id);
    if (!job) continue;
    const row = verified.get(job.id)!.find((a) => a.area_id === key.areaId && a.product === key.product);
    if (!row || row.exclude_from_learning) continue;
    const actual = key.metric === 'qty' ? row.actual_material_qty : row.actual_hours;
    if (actual === null || !(actual > 0)) continue;
    out.push({ id: flag.id, quoteId: job.quote_id, lineKey: lineKey(key.areaId, key.product, key.kind), metric: key.metric, actual });
  }
  return out;
}

const signedLineSchema = z.looseObject({
  key: z.string().nullish(),
  isOverridden: z.boolean().nullish(),
  qty: z.number().nullish(),
  hours: z.number().nullish(),
  modelQty: z.number().nullish(),
  modelHours: z.number().nullish(),
});
type SignedLine = z.infer<typeof signedLineSchema>;
const signedOptionsSchema = z.array(z.looseObject({ tier: z.enum(TIERS), lines: z.array(signedLineSchema) }));

/** The lines of the option the customer signed, as frozen in the quote ([] when unreadable). */
function signedLines(quote: FlagQuoteRow): SignedLine[] {
  const options = signedOptionsSchema.safeParse(quote.options);
  if (!options.success || !quote.signed_tier) return [];
  return options.data.find((o) => o.tier === quote.signed_tier)?.lines ?? [];
}

/**
 * Outcome per scorable flag, read from the signed option: the estimator's number is that line's
 * own qty/hours, the model's its modelQty/modelHours. The flag row's values are not used: the row
 * is rewritten on every sync (it can describe a revision made after the quote that was signed)
 * and is stored once per line on one tier, while each tier has its own model value. A line that
 * is missing from the signed option or not changed there was never installed as the estimator's
 * deviation, so it gets no outcome (the column has no neutral value); see updateDeviationOutcomes.
 */
export function lineFlagOutcomes(
  flags: readonly ScorableLineFlag[],
  quotes: readonly FlagQuoteRow[],
): Array<{ id: string; outcome: DeviationOutcome }> {
  const lines = new Map(quotes.map((q) => [q.id, signedLines(q)]));
  const out: Array<{ id: string; outcome: DeviationOutcome }> = [];
  for (const flag of flags) {
    const line = lines.get(flag.quoteId)?.find((l) => l.key === flag.lineKey);
    if (!line?.isOverridden) continue;
    const estimator = flag.metric === 'qty' ? line.qty : line.hours;
    const model = flag.metric === 'qty' ? line.modelQty : line.modelHours;
    if (estimator == null || model == null) continue;
    out.push({ id: flag.id, outcome: deviationOutcome(estimator, model, flag.actual) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rows written by the nightly job
// ---------------------------------------------------------------------------

// Column limits in the coefficients table: numeric(14,6), numeric(10,2), int.
const NUMERIC_14_6_MAX = 99_999_999.999999;
const NUMERIC_10_2_MAX = 99_999_999.99;
const INT_MAX = 2_147_483_647;

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** A value column: must be a finite number the numeric(14,6) column can hold. */
function storable(n: number, what: string): number {
  if (!Number.isFinite(n)) throw new Error(`Candidate ${what} is not a finite number`);
  if (Math.abs(n) > NUMERIC_14_6_MAX) throw new Error(`Candidate ${what} (${n}) is too large to store`);
  return round(n, 6);
}

/** An evidence column: clipped into [0, max]; non-finite evidence counts as none. */
const evidence = (n: number, dp: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(0, round(n, dp))) : 0);

const scopeLabel = (c: StoredCoefficient) =>
  `${c.kind}(${[c.product, c.jobType, c.accessLevel].map((x) => x ?? '*').join('/')})`;

/**
 * One coefficients row: values to 6 dp (numeric(14,6)), n_eff and confidence to 2 dp, confidence
 * in 0..100, every number within its column's range. A standard error the column cannot hold
 * carries no information and is stored as null.
 */
export function coefficientRow(setId: string, c: CandidateCoefficient): Record<string, unknown> {
  const label = scopeLabel(c);
  const se = c.stdError !== null && Number.isFinite(c.stdError) && Math.abs(c.stdError) <= NUMERIC_14_6_MAX ? round(c.stdError, 6) : null;
  return {
    set_id: setId,
    kind: c.kind,
    product: c.product,
    job_type: c.jobType,
    access_level: c.accessLevel,
    value: storable(c.value, `${label} value`),
    prior_value: storable(c.priorValue, `${label} prior`),
    lower_bound: storable(c.lowerBound, `${label} lower bound`),
    upper_bound: storable(c.upperBound, `${label} upper bound`),
    std_error: se,
    sample_size: evidence(c.sampleSize, 0, INT_MAX),
    n_eff: evidence(c.nEff, 2, NUMERIC_10_2_MAX),
    confidence: evidence(c.confidence, 2, 100),
    was_clamped: c.wasClamped,
    was_step_limited: c.wasStepLimited,
  };
}

/** The coefficient_sets row for a nightly candidate (status 'candidate'; promotion is separate). */
export function candidateSetRow(args: { runId: string; parentSetId: string; result: CalibrationResult }): Record<string, unknown> {
  const { result } = args;
  return {
    status: 'candidate',
    source: 'nightly',
    parent_id: args.parentSetId,
    learning_run_id: args.runId,
    metrics: {
      holdout: result.metrics.holdout,
      nObservations: result.metrics.nObservations,
      nUsed: result.metrics.nUsed,
      changedCount: result.changedCount,
      // The coefficients table has no note column; the changelog explanations live here.
      notes: result.coefficients
        .filter((c) => c.changed)
        .map((c) => ({ kind: c.kind, product: c.product, jobType: c.jobType, accessLevel: c.accessLevel, note: c.note })),
    },
    gate_results: { gates: result.gates },
    notes: `Nightly calibration: ${result.changedCount} ${result.changedCount === 1 ? 'coefficient' : 'coefficients'} changed from ${result.metrics.nUsed} of ${result.metrics.nObservations} observations.`,
  };
}

/** The win_models row, inactive until insertWinModel switches it on. Params match lib/server/snapshot.ts. */
export function winModelRow(runId: string, model: Omit<WinModel, 'id' | 'trainedAt'>): Record<string, unknown> {
  return {
    learning_run_id: runId,
    n_quotes: model.nQuotes,
    params: { weights: model.weights, jobTypes: model.jobTypes, sources: model.sources },
    metrics: model.metrics,
    is_active: false,
  };
}

// ---------------------------------------------------------------------------
// Cron authorization
// ---------------------------------------------------------------------------

/**
 * True when the Authorization header is exactly `Bearer <secret>`. Both sides are hashed first so
 * timingSafeEqual always compares equal-length buffers and the secret's length does not leak.
 */
export function cronAuthorized(header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

// ---------------------------------------------------------------------------
// The nightly run
// ---------------------------------------------------------------------------

export interface ActiveCoefficients {
  setId: string;
  version: number;
  coefficients: StoredCoefficient[];
}

export type RunKind = 'calibration' | 'win_model';

export interface RunFinish {
  status: 'succeeded' | 'failed';
  jobsConsidered: number | null;
  jobsUsed: number | null;
  candidateSetId: string | null;
  promoted: boolean;
  summary: Record<string, unknown>;
  error: string | null;
}

export interface EmailOut {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Everything the nightly run does to the outside world (lib/learning/io.ts in production). */
export interface NightlyDeps {
  loadSettings(): Promise<LearningSettings>;
  expireStaleQuotes(): Promise<number>;
  /** Inserts a 'running' learning_runs row; null while another run of this kind is still running. */
  startRun(kind: RunKind, summary: Record<string, unknown>): Promise<string | null>;
  finishRun(runId: string, finish: RunFinish): Promise<void>;
  loadActiveCoefficients(): Promise<ActiveCoefficients>;
  loadActiveSetId(): Promise<string | null>;
  loadJobsForLearning(): Promise<JobForLearning[]>;
  insertCandidateSet(args: { runId: string; parentSetId: string; result: CalibrationResult }): Promise<string>;
  rejectSet(setId: string, reason: string): Promise<void>;
  promoteSet(setId: string, reason: string): Promise<void>;
  loadDecidedQuotes(): Promise<QuoteOutcomeRow[]>;
  insertWinModel(runId: string, model: Omit<WinModel, 'id' | 'trainedAt'>): Promise<string>;
  updateDeviationOutcomes(): Promise<number>;
  ownerEmail: string | null;
  sendEmail(msg: EmailOut): Promise<unknown>;
  /** Wall clock for finishedAt (the run's `now` is fixed). */
  clock(): Date;
  log?(message: string): void;
  /** Tests only: replaces the calibration math. */
  calibrate?(input: CalibrationInput): CalibrationResult;
}

interface RunOptions {
  trigger: 'cron' | 'manual';
  actorId?: string;
}

type Fail = (step: string, e: unknown) => string;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs the four nightly steps in order, each isolated in its own try/catch: (A) expire stale
 * quotes, (B) calibrate a candidate coefficient set and promote it only when every gate passed
 * and auto-promote is on, (C) retrain the win model, (D) score deviation flags against actuals.
 * A failed step is recorded (learning_runs + summary) and never promotes; later steps still
 * run; the owner is emailed when anything failed. Never throws except for an invalid `now`.
 */
export async function runNightlyWith(deps: NightlyDeps, now: Date, opts: RunOptions): Promise<NightlySummary> {
  if (!Number.isFinite(now.getTime())) throw new RangeError('runNightly: `now` is not a valid date');
  const startedAt = now.toISOString();
  const problems: string[] = [];
  const fail: Fail = (step, e) => {
    const message = errorMessage(e);
    problems.push(`${step}: ${message}`);
    deps.log?.(`[nightly] ${step} failed: ${message}`);
    return message;
  };
  const meta: Record<string, unknown> = { trigger: opts.trigger };
  if (opts.trigger === 'manual') meta.actorId = opts.actorId ?? null;

  let settings: LearningSettings | null = null;
  try {
    settings = await deps.loadSettings();
  } catch (e) {
    fail('Loading learning settings', e);
  }

  // A. Quotes past their expiry date become decided losses for the win model below.
  let expiredQuotes: number | null = null;
  try {
    expiredQuotes = await deps.expireStaleQuotes();
  } catch (e) {
    fail('Expiring stale quotes', e);
  }

  const calibration = settings
    ? await calibrationStep(deps, now, settings, meta, fail)
    : { ...emptyCalibration(), error: 'Learning settings could not be loaded.' };
  const winModel = settings
    ? await winModelStep(deps, now, settings, meta, fail)
    : { ...emptyWinModel(), reason: 'Learning settings could not be loaded.', error: 'Learning settings could not be loaded.' };

  // D. After calibration: tonight's newly verified jobs settle their flags.
  let deviationOutcomesUpdated: number | null = null;
  try {
    deviationOutcomesUpdated = await deps.updateDeviationOutcomes();
  } catch (e) {
    fail('Scoring deviation flags', e);
  }

  const summary: NightlySummary = {
    startedAt,
    finishedAt: deps.clock().toISOString(),
    trigger: opts.trigger,
    expiredQuotes,
    calibration,
    winModel,
    deviationOutcomesUpdated,
  };
  if (problems.length) await notifyOwner(deps, now, problems);
  return summary;
}

function emptyCalibration(): NightlySummary['calibration'] {
  return {
    runId: null,
    status: 'failed',
    jobsConsidered: 0,
    jobsUsed: 0,
    candidateSetId: null,
    changedCount: 0,
    promoted: false,
    gates: [],
    holdout: null,
    accuracy: null,
    error: null,
  };
}

function emptyWinModel(): NightlySummary['winModel'] {
  return { runId: null, status: 'failed', nQuotes: 0, trained: false, reason: '', buckets: null, error: null };
}

/** What happened to the candidate, for the run log and the dashboard. */
type CandidateOutcome = 'no_change' | 'not_stored' | 'rejected' | 'promoted' | 'awaiting_approval';

async function calibrationStep(
  deps: NightlyDeps,
  now: Date,
  settings: LearningSettings,
  meta: Record<string, unknown>,
  fail: Fail,
): Promise<NightlySummary['calibration']> {
  const out = emptyCalibration();
  let result: CalibrationResult | null = null;
  let outcome: CandidateOutcome | null = null;
  let message = '';
  try {
    const runId = await deps.startRun('calibration', { ...meta });
    if (runId === null) {
      return { ...out, status: 'skipped', error: 'Another calibration run is still in progress.' };
    }
    out.runId = runId;

    const active = await deps.loadActiveCoefficients();
    const jobs = await deps.loadJobsForLearning();
    const observations: Observation[] = [];
    const drive: DriveObservation[] = [];
    const used = new Set<string>();
    for (const job of jobs) {
      const r = observationsFromJob(job);
      observations.push(...r.observations);
      if (r.drive) drive.push(r.drive);
      if (r.observations.length || r.drive) used.add(job.jobId);
    }
    out.jobsConsidered = jobs.length;
    out.jobsUsed = used.size;
    out.accuracy = estimateAccuracy(observations);

    result = (deps.calibrate ?? realCalibrate)({ observations, drive, active: active.coefficients, settings, now });
    out.gates = result.gates;
    out.holdout = result.metrics.holdout;
    out.changedCount = result.changedCount;

    const failed = result.gates.filter((g) => !g.passed);
    if (result.changedCount === 0) {
      outcome = 'no_change';
      message = 'No coefficient moved; no candidate was created.';
    } else if (failed.some((g) => g.name === 'sanity')) {
      // Values that fail the sanity gate would violate the coefficients table's checks.
      outcome = 'not_stored';
      message = `Candidate not stored: ${failed.map((g) => g.detail).join(' ')}`;
    } else {
      const setId = await deps.insertCandidateSet({ runId, parentSetId: active.setId, result });
      out.candidateSetId = setId;
      if (!result.passed) {
        const reason = `Failed gate(s): ${failed.map((g) => `${g.name}: ${g.detail}`).join(' ')}`;
        await deps.rejectSet(setId, reason);
        outcome = 'rejected';
        message = `Candidate rejected. ${reason}`;
      } else if (!result.autoPromotable) {
        outcome = 'awaiting_approval';
        message = settings.autoPromote
          ? 'Every gate passed but the backtest had too little recent data to promote automatically; awaiting owner approval.'
          : 'Every gate passed; awaiting owner approval (auto-promote is off).';
      } else if ((await deps.loadActiveSetId()) !== active.setId) {
        // An owner rollback or approval landed mid-run; never overwrite it with a stale candidate.
        outcome = 'awaiting_approval';
        message = 'Every gate passed, but the active set changed during the run; awaiting owner approval.';
      } else {
        await deps.promoteSet(setId, `Nightly calibration ${businessDate(now)}: ${result.changedCount} changed, every gate passed (auto-promote).`);
        out.promoted = true;
        outcome = 'promoted';
        message = 'Every gate passed; promoted automatically.';
      }
    }
    out.status = 'succeeded';
  } catch (e) {
    out.status = 'failed';
    out.error = fail('Calibration', e);
  }

  if (out.runId) {
    try {
      await deps.finishRun(out.runId, {
        status: out.status === 'succeeded' ? 'succeeded' : 'failed',
        jobsConsidered: out.jobsConsidered,
        jobsUsed: out.jobsUsed,
        candidateSetId: out.candidateSetId,
        promoted: out.promoted,
        error: out.error,
        summary: {
          ...meta,
          settings,
          outcome,
          message,
          gates: out.gates,
          holdout: out.holdout,
          changedCount: out.changedCount,
          accuracy: out.accuracy,
          nObservations: result?.metrics.nObservations ?? 0,
          nUsed: result?.metrics.nUsed ?? 0,
          autoPromotable: result?.autoPromotable ?? false,
        },
      });
    } catch (e) {
      const msg = fail('Recording the calibration run', e);
      if (out.status === 'succeeded') {
        out.status = 'failed';
        out.error = `Recording the run failed: ${msg}`;
      }
    }
  }
  return out;
}

async function winModelStep(
  deps: NightlyDeps,
  now: Date,
  settings: LearningSettings,
  meta: Record<string, unknown>,
  fail: Fail,
): Promise<NightlySummary['winModel']> {
  const out = emptyWinModel();
  let decided = 0;
  let modelId: string | null = null;
  let metrics: WinModel['metrics'] | null = null;
  try {
    const runId = await deps.startRun('win_model', { ...meta });
    if (runId === null) {
      const reason = 'Another win-model run is still in progress.';
      return { ...out, status: 'skipped', reason, error: reason };
    }
    out.runId = runId;

    const rows = await deps.loadDecidedQuotes();
    decided = rows.length;
    const observations = rows.map(winObservationFromQuote).filter((o): o is WinObservation => o !== null);
    out.nQuotes = observations.length;
    // Buckets are the cold-start view and the dashboard's breakdown: always stored.
    out.buckets = winRateBuckets(observations);
    const { model, reason } = trainWinModel(observations, {
      now,
      halfLifeDays: settings.winHalfLifeDays,
      l2: settings.winL2,
      minQuotes: settings.minQuotesForWinModel,
    });
    out.reason = reason;
    if (model) {
      modelId = await deps.insertWinModel(runId, model);
      metrics = model.metrics;
      out.trained = true;
    }
    out.status = 'succeeded';
  } catch (e) {
    out.status = 'failed';
    out.error = fail('Win model', e);
    out.reason ||= 'The win-model run failed.';
  }

  if (out.runId) {
    try {
      await deps.finishRun(out.runId, {
        status: out.status === 'succeeded' ? 'succeeded' : 'failed',
        jobsConsidered: decided,
        jobsUsed: out.nQuotes,
        candidateSetId: null,
        promoted: false,
        error: out.error,
        summary: {
          ...meta,
          settings: {
            minQuotesForWinModel: settings.minQuotesForWinModel,
            winHalfLifeDays: settings.winHalfLifeDays,
            winL2: settings.winL2,
          },
          decidedQuotes: decided,
          nQuotes: out.nQuotes,
          trained: out.trained,
          reason: out.reason,
          modelId,
          metrics,
          buckets: out.buckets,
        },
      });
    } catch (e) {
      const msg = fail('Recording the win-model run', e);
      if (out.status === 'succeeded') {
        out.status = 'failed';
        out.error = `Recording the run failed: ${msg}`;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** "Oct 20, 2026" in Newark, DE. */
export function businessDate(d: Date): string {
  return d.toLocaleDateString('en-US', { timeZone: BUSINESS_TZ, year: 'numeric', month: 'short', day: 'numeric' });
}

/** True when any step failed (the cron route answers 500 so the failure shows in Vercel's log). */
export function summaryHasFailures(s: NightlySummary): boolean {
  return (
    s.expiredQuotes === null ||
    s.calibration.status === 'failed' ||
    s.winModel.status === 'failed' ||
    s.deviationOutcomesUpdated === null
  );
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

/** The owner's notice when a nightly step failed. */
export function nightlyFailureEmail(now: Date, problems: readonly string[]): Omit<EmailOut, 'to'> {
  const date = businessDate(now);
  const subject = `Nightly learning run had ${problems.length === 1 ? 'a problem' : `${problems.length} problems`} (${date})`;
  const reassurance =
    'Pricing is unaffected: a failed step never changes the active coefficient set. The next nightly run will try again.';
  const text = [`The nightly learning run for ${date} did not finish cleanly:`, '', ...problems.map((p) => `- ${p}`), '', reassurance].join('\n');
  const html = `<p>The nightly learning run for ${escapeHtml(date)} did not finish cleanly:</p>
<ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
<p>${escapeHtml(reassurance)}</p>`;
  return { subject, html, text };
}

async function notifyOwner(deps: NightlyDeps, now: Date, problems: readonly string[]): Promise<void> {
  if (!deps.ownerEmail) return;
  try {
    await deps.sendEmail({ to: deps.ownerEmail, ...nightlyFailureEmail(now, problems) });
  } catch (e) {
    // The run's results are already recorded; a mail outage must not turn into a failed run.
    deps.log?.(`[nightly] emailing the owner failed: ${errorMessage(e)}`);
  }
}

// Pure helpers for the owner's learning dashboard (app/admin/learning, PLAN.md §6): plain-English
// names for coefficient kinds and scopes, the candidate-vs-active diff, row schemas for the
// learning tables, lenient parsers for the jsonb the nightly job writes (gate results, backtest,
// accuracy, win-rate buckets), the action forms, and number/date formatting in Newark, DE time.
// No I/O and no server-only imports, so client components can use the formatters too.
import { z } from 'zod';
import {
  ACCESS_LEVELS,
  COEFF_KINDS,
  findCoefficient,
  JOB_TYPES,
  PRODUCTS,
  type AccessLevel,
  type CoeffKind,
  type JobType,
  type ProductCode,
} from '@/lib/pricing';
import type { AccuracyReport, BacktestMetrics, GateResult, WinRateBucket } from '@/lib/learning';
import type { NightlySummary } from '@/lib/learning/nightly';
import { optionalTextField, textField, uuidField } from './forms';

/** Business dates and times are Newark, DE local time. */
export const BUSINESS_TZ = 'America/New_York';

// ---------------------------------------------------------------------------
// Coefficient kinds and scopes
// ---------------------------------------------------------------------------

export const KIND_LABELS: Record<CoeffKind, string> = {
  waste_factor: 'Waste factor',
  labor_hrs_per_unit: 'Labor hours per unit',
  access_mult: 'Access multiplier',
  setup_hours: 'Setup hours',
  removal_hrs_per_sqft: 'Removal hours per sq ft',
  drive_time_factor: 'Drive time factor',
  photo_area_bias: 'Photo area bias',
};

/** One sentence per kind for the owner: what the number means on a job. */
export const KIND_HELP: Record<CoeffKind, string> = {
  waste_factor: 'Material the crew actually uses ÷ what the design calls for. 1.10 means 10% extra for waste and overspray.',
  labor_hrs_per_unit: 'Crew person-hours per bag, board foot or square foot installed, before the access multiplier.',
  access_mult: 'How much longer the same work takes at each access level, compared with easy access.',
  setup_hours: 'Fixed person-hours per area for setup and cleanup, whatever its size.',
  removal_hrs_per_sqft: 'Person-hours to remove old insulation, per square foot.',
  drive_time_factor: 'Actual drive time ÷ the map estimate.',
  photo_area_bias: 'Confirmed square feet ÷ the photo estimate (photo takeoff, Phase 3).',
};

export interface CoefficientScope {
  kind: CoeffKind;
  product: ProductCode | null;
  jobType: JobType | null;
  accessLevel: AccessLevel | null;
}

/** Display names from the products / job_types / access_levels tables; missing codes fall back to the code. */
export interface ScopeNames {
  products?: Partial<Record<ProductCode, string>>;
  jobTypes?: Partial<Record<JobType, string>>;
  accessLevels?: Partial<Record<AccessLevel, string>>;
}

const humanize = (code: string) => code.replace(/_/g, ' ');
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sentenceCase = (s: string) => capitalize(s.toLowerCase());

/** Builds ScopeNames from {code, label} rows, ignoring codes the app does not know. */
export function scopeNamesFrom(rows: {
  products?: ReadonlyArray<{ code: string; label: string }>;
  jobTypes?: ReadonlyArray<{ code: string; label: string }>;
  accessLevels?: ReadonlyArray<{ code: string; label: string }>;
}): ScopeNames {
  const pick = <T extends string>(codes: readonly T[], list: ReadonlyArray<{ code: string; label: string }> = []) => {
    const out: Partial<Record<T, string>> = {};
    for (const r of list) if ((codes as readonly string[]).includes(r.code) && r.label.trim()) out[r.code as T] = r.label.trim();
    return out;
  };
  return {
    products: pick(PRODUCTS, rows.products),
    jobTypes: pick(JOB_TYPES, rows.jobTypes),
    accessLevels: pick(ACCESS_LEVELS, rows.accessLevels),
  };
}

export const productName = (p: ProductCode, names: ScopeNames = {}) => sentenceCase(names.products?.[p] ?? humanize(p));
export const jobTypeName = (j: JobType, names: ScopeNames = {}) => sentenceCase(names.jobTypes?.[j] ?? humanize(j));
export const accessName = (a: AccessLevel, names: ScopeNames = {}) => sentenceCase(names.accessLevels?.[a] ?? humanize(a));

/** A job-type code from stored data (e.g. win-rate buckets); unknown codes are shown as they are. */
export function jobTypeLabel(code: string, names: ScopeNames = {}): string {
  return (JOB_TYPES as readonly string[]).includes(code) ? jobTypeName(code as JobType, names) : code;
}

/**
 * Where a coefficient applies, in plain words: "Blown cellulose · attic", "Difficult access",
 * "Attic", or "All jobs" for a global one.
 */
export function scopeLabel(s: Omit<CoefficientScope, 'kind'>, names: ScopeNames = {}): string {
  const parts: string[] = [];
  if (s.product) parts.push(productName(s.product, names));
  if (s.jobType) parts.push(jobTypeName(s.jobType, names).toLowerCase());
  if (s.accessLevel) parts.push(`${accessName(s.accessLevel, names).toLowerCase()} access`);
  return parts.length ? capitalize(parts.join(' · ')) : 'All jobs';
}

/** Identity of a coefficient within a set: (kind, product, job type, access level). */
export function scopeKey(s: CoefficientScope): string {
  return [s.kind, s.product ?? '*', s.jobType ?? '*', s.accessLevel ?? '*'].join('|');
}

const rank = <T extends string>(list: readonly T[], v: T | null) => (v === null ? -1 : list.indexOf(v));

/** Kind order, then product, job type and access level; the unscoped (parent) cell first. */
export function compareScopes(a: CoefficientScope, b: CoefficientScope): number {
  return (
    rank(COEFF_KINDS, a.kind) - rank(COEFF_KINDS, b.kind) ||
    rank(PRODUCTS, a.product) - rank(PRODUCTS, b.product) ||
    rank(JOB_TYPES, a.jobType) - rank(JOB_TYPES, b.jobType) ||
    rank(ACCESS_LEVELS, a.accessLevel) - rank(ACCESS_LEVELS, b.accessLevel)
  );
}

/** Coefficients grouped by kind (in the engine's kind order), each group sorted by scope. */
export function groupByKind<T extends CoefficientScope>(rows: readonly T[]): Array<{ kind: CoeffKind; label: string; help: string; rows: T[] }> {
  return COEFF_KINDS.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    help: KIND_HELP[kind],
    rows: rows.filter((r) => r.kind === kind).sort(compareScopes),
  })).filter((g) => g.rows.length > 0);
}

// ---------------------------------------------------------------------------
// Rows from the learning tables (numeric columns may arrive as strings)
// ---------------------------------------------------------------------------

const numeric = z.union([z.number(), z.string().trim().min(1)]).transform(Number).pipe(z.number());
const id = z.string().min(1);

export const COEFFICIENT_COLUMNS =
  'kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound, std_error, sample_size, n_eff, confidence, was_clamped, was_step_limited';

export const coefficientRowSchema = z
  .object({
    kind: z.enum(COEFF_KINDS),
    product: z.enum(PRODUCTS).nullable(),
    job_type: z.enum(JOB_TYPES).nullable(),
    access_level: z.enum(ACCESS_LEVELS).nullable(),
    value: numeric,
    prior_value: numeric,
    lower_bound: numeric,
    upper_bound: numeric,
    std_error: numeric.nullable(),
    sample_size: numeric,
    n_eff: numeric,
    confidence: numeric,
    was_clamped: z.boolean(),
    // Added in the Phase 2 migration; older rows and fixtures may lack it.
    was_step_limited: z.boolean().optional().default(false),
  })
  .transform((r) => ({
    kind: r.kind,
    product: r.product,
    jobType: r.job_type,
    accessLevel: r.access_level,
    value: r.value,
    priorValue: r.prior_value,
    lowerBound: r.lower_bound,
    upperBound: r.upper_bound,
    stdError: r.std_error,
    sampleSize: r.sample_size,
    nEff: r.n_eff,
    confidence: r.confidence,
    wasClamped: r.was_clamped,
    wasStepLimited: r.was_step_limited,
  }));
export type DashboardCoefficient = z.output<typeof coefficientRowSchema>;

export const SET_STATUSES = ['candidate', 'active', 'superseded', 'rejected'] as const;
export type SetStatus = (typeof SET_STATUSES)[number];

/** History columns; the jsonb metrics (per-coefficient notes) are loaded for the candidate only. */
export const SET_COLUMNS = 'id, version, status, source, parent_id, notes, created_at, created_by, activated_at, activated_by';

export const coefficientSetRowSchema = z.object({
  id,
  version: numeric,
  status: z.enum(SET_STATUSES),
  source: z.string(),
  parent_id: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  activated_at: z.string().nullable(),
  activated_by: z.string().nullable(),
});
export type CoefficientSetRow = z.infer<typeof coefficientSetRowSchema>;

export const CANDIDATE_SET_COLUMNS = `${SET_COLUMNS}, learning_run_id, metrics, gate_results`;

export const candidateSetRowSchema = coefficientSetRowSchema.extend({
  learning_run_id: z.string().nullable(),
  metrics: z.unknown(),
  gate_results: z.unknown(),
});
export type CandidateSetRow = z.infer<typeof candidateSetRowSchema>;

export const RUN_COLUMNS = 'id, kind, started_at, finished_at, status, jobs_considered, jobs_used, candidate_set_id, promoted, summary, error';

export const learningRunRowSchema = z.object({
  id,
  kind: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  status: z.enum(['running', 'succeeded', 'failed']),
  jobs_considered: numeric.nullable(),
  jobs_used: numeric.nullable(),
  candidate_set_id: z.string().nullable(),
  promoted: z.boolean(),
  summary: z.unknown(),
  error: z.string().nullable(),
});
export type LearningRunRow = z.infer<typeof learningRunRowSchema>;

export const CHANGE_COLUMNS =
  'id, at, from_set_id, to_set_id, kind, product, job_type, access_level, old_value, new_value, pct_change, reason, actor_id';

export const coefficientChangeRowSchema = z
  .object({
    id: numeric,
    at: z.string(),
    from_set_id: z.string().nullable(),
    to_set_id: id,
    kind: z.enum(COEFF_KINDS),
    product: z.enum(PRODUCTS).nullable(),
    job_type: z.enum(JOB_TYPES).nullable(),
    access_level: z.enum(ACCESS_LEVELS).nullable(),
    old_value: numeric.nullable(),
    new_value: numeric,
    pct_change: numeric.nullable(),
    reason: z.string(),
    actor_id: z.string().nullable(),
  })
  .transform((r) => ({
    id: r.id,
    at: r.at,
    fromSetId: r.from_set_id,
    toSetId: r.to_set_id,
    kind: r.kind,
    product: r.product,
    jobType: r.job_type,
    accessLevel: r.access_level,
    oldValue: r.old_value,
    newValue: r.new_value,
    pctChange: r.pct_change,
    reason: r.reason,
    actorId: r.actor_id,
  }));
export type CoefficientChange = z.output<typeof coefficientChangeRowSchema>;

export const WIN_MODEL_COLUMNS = 'id, trained_at, n_quotes, metrics, learning_run_id';

export const winModelRowSchema = z.object({
  id,
  trained_at: z.string(),
  n_quotes: numeric,
  metrics: z.unknown(),
  learning_run_id: z.string().nullable(),
});
export type WinModelRow = z.infer<typeof winModelRowSchema>;

export const profileNameRowSchema = z.object({ id, full_name: z.string() });

/** Parses every row or throws naming the table and the first problem. */
export function parseRows<T extends z.ZodType>(schema: T, rows: unknown, what: string): Array<z.output<T>> {
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error(`Unexpected ${what} data: not a list`);
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

/** Like parseRows for a single optional row (maybeSingle). */
export function parseRow<T extends z.ZodType>(schema: T, row: unknown, what: string): z.output<T> | null {
  if (row === null || row === undefined) return null;
  return parseRows(schema, [row], what)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Candidate vs active
// ---------------------------------------------------------------------------

export type ChangeType = 'new' | 'changed' | 'removed';

export interface CoefficientDiff extends CoefficientScope {
  key: string;
  change: ChangeType;
  /** The active set's value for this exact cell; null for a new cell. */
  oldValue: number | null;
  /** What pricing used for this scope until now: the active cell, or for a new cell its closest active parent. */
  baseValue: number | null;
  /** Null when the candidate drops a cell the active set has. */
  newValue: number | null;
  /** Relative change from baseValue to newValue. */
  pctChange: number | null;
  sampleSize: number | null;
  nEff: number | null;
  confidence: number | null;
  stdError: number | null;
  wasClamped: boolean;
  wasStepLimited: boolean;
  note: string | null;
}

/** The changelog treats values as equal below this (coefficients are numeric(14,6)). */
const VALUE_EPS = 1e-9;

const differs = (a: number, b: number) => Math.abs(a - b) > VALUE_EPS;

/** Relative change (to - from) / |from|; null when either side is missing, non-finite, or from is 0. */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return (to - from) / Math.abs(from);
}

/**
 * Per-coefficient notes the nightly job stores in coefficient_sets.metrics.notes (the
 * coefficients table has no note column), keyed by scopeKey. Malformed entries are skipped.
 */
export function candidateNotes(metrics: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = asRecord(metrics)?.notes;
  if (!Array.isArray(list)) return out;
  const entry = z.object({
    kind: z.enum(COEFF_KINDS),
    product: z.enum(PRODUCTS).nullish().transform((v) => v ?? null),
    jobType: z.enum(JOB_TYPES).nullish().transform((v) => v ?? null),
    accessLevel: z.enum(ACCESS_LEVELS).nullish().transform((v) => v ?? null),
    note: z.string(),
  });
  for (const item of list) {
    const r = entry.safeParse(item);
    if (r.success) out.set(scopeKey(r.data), r.data.note);
  }
  return out;
}

/** The calibration note says so when the ±step limit held a value back (there is no column for it). */
export const isStepLimitedNote = (note: string | null | undefined) => typeof note === 'string' && /step-limited/i.test(note);

/**
 * The coefficients a candidate set would change if approved: new cells, changed values and cells
 * it drops, sorted by kind and scope. Unchanged cells are left out.
 */
export function diffCoefficients(
  candidate: readonly DashboardCoefficient[],
  active: readonly DashboardCoefficient[],
  notes: ReadonlyMap<string, string> = new Map(),
): CoefficientDiff[] {
  const activeByKey = new Map(active.map((a) => [scopeKey(a), a]));
  const activeSet = { id: '', version: 0, coefficients: [...active] };
  const seen = new Set<string>();
  const out: CoefficientDiff[] = [];

  for (const c of candidate) {
    const key = scopeKey(c);
    seen.add(key);
    const a = activeByKey.get(key);
    if (a && !differs(a.value, c.value)) continue;
    const baseValue = a ? a.value : (findCoefficient(activeSet, c.kind, c)?.value ?? null);
    const note = notes.get(key) ?? null;
    out.push({
      key,
      kind: c.kind,
      product: c.product,
      jobType: c.jobType,
      accessLevel: c.accessLevel,
      change: a ? 'changed' : 'new',
      oldValue: a ? a.value : null,
      baseValue,
      newValue: c.value,
      pctChange: pctChange(baseValue, c.value),
      sampleSize: c.sampleSize,
      nEff: c.nEff,
      confidence: c.confidence,
      stdError: c.stdError,
      wasClamped: c.wasClamped,
      wasStepLimited: c.wasStepLimited || isStepLimitedNote(note),
      note,
    });
  }

  for (const [key, a] of activeByKey) {
    if (seen.has(key)) continue;
    out.push({
      key,
      kind: a.kind,
      product: a.product,
      jobType: a.jobType,
      accessLevel: a.accessLevel,
      change: 'removed',
      oldValue: a.value,
      baseValue: a.value,
      newValue: null,
      pctChange: null,
      sampleSize: null,
      nEff: null,
      confidence: null,
      stdError: null,
      wasClamped: false,
      wasStepLimited: false,
      note: notes.get(key) ?? null,
    });
  }
  return out.sort(compareScopes);
}

// ---------------------------------------------------------------------------
// Lenient jsonb parsing (coefficient_sets.metrics / gate_results, learning_runs.summary)
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A finite number (numbers or numeric strings), else null. */
function finiteOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export const GATE_LABELS: Record<GateResult['name'], string> = {
  bounds: 'Hard bounds',
  step_limit: 'Step limit',
  min_evidence: 'Minimum evidence',
  backtest: 'Backtest',
  sanity: 'Sanity check',
};

export interface GateView {
  name: string;
  label: string;
  passed: boolean;
  detail: string;
}

/** gate_results.gates (or a bare list) as display rows; malformed entries are skipped. */
export function parseGates(gateResults: unknown): GateView[] {
  const list = Array.isArray(gateResults) ? gateResults : asRecord(gateResults)?.gates;
  if (!Array.isArray(list)) return [];
  const out: GateView[] = [];
  for (const item of list) {
    const g = asRecord(item);
    if (!g || typeof g.name !== 'string' || typeof g.passed !== 'boolean') continue;
    const label = Object.prototype.hasOwnProperty.call(GATE_LABELS, g.name) ? GATE_LABELS[g.name as GateResult['name']] : capitalize(humanize(g.name));
    out.push({ name: g.name, label, passed: g.passed, detail: typeof g.detail === 'string' ? g.detail : '' });
  }
  return out;
}

/** Backtest metrics from coefficient_sets.metrics.holdout (or a run summary's holdout). */
export function parseHoldout(metrics: unknown): BacktestMetrics | null {
  const h = asRecord(asRecord(metrics)?.holdout);
  if (!h) return null;
  const n = finiteOrNull(h.n);
  if (n === null) return null;
  return {
    n,
    hoursMapeActive: finiteOrNull(h.hoursMapeActive),
    hoursMapeCandidate: finiteOrNull(h.hoursMapeCandidate),
    qtyMapeActive: finiteOrNull(h.qtyMapeActive),
    qtyMapeCandidate: finiteOrNull(h.qtyMapeCandidate),
  };
}

export interface BacktestRow {
  metric: 'hours' | 'qty';
  label: string;
  active: number | null;
  candidate: number | null;
  /** Lower error is better; null when either side is missing. */
  verdict: 'better' | 'worse' | 'same' | null;
}

/** Holdout error of the active set vs the candidate, per metric. */
export function backtestRows(h: BacktestMetrics): BacktestRow[] {
  const row = (metric: BacktestRow['metric'], label: string, active: number | null, candidate: number | null): BacktestRow => ({
    metric,
    label,
    active,
    candidate,
    verdict: active === null || candidate === null ? null : Math.abs(candidate - active) <= 1e-9 ? 'same' : candidate < active ? 'better' : 'worse',
  });
  return [
    row('hours', 'Labor hours', h.hoursMapeActive, h.hoursMapeCandidate),
    row('qty', 'Material quantity', h.qtyMapeActive, h.qtyMapeCandidate),
  ];
}

/** summary.accuracy of a calibration run (lib/learning/accuracy.ts), or null when absent/malformed. */
export function parseAccuracy(summary: unknown): AccuracyReport | null {
  const a = asRecord(asRecord(summary)?.accuracy);
  if (!a) return null;
  const n = finiteOrNull(a.n);
  if (n === null) return null;
  return {
    n,
    hoursMapeModel: finiteOrNull(a.hoursMapeModel),
    hoursMapeEstimator: finiteOrNull(a.hoursMapeEstimator),
    qtyMapeModel: finiteOrNull(a.qtyMapeModel),
    qtyMapeEstimator: finiteOrNull(a.qtyMapeEstimator),
  };
}

/** True when the report has at least one error figure worth showing. */
export function hasAccuracy(r: AccuracyReport | null): r is AccuracyReport {
  return !!r && r.n > 0 && [r.hoursMapeModel, r.hoursMapeEstimator, r.qtyMapeModel, r.qtyMapeEstimator].some((v) => v !== null);
}

/** MAPE in plain words: "On average the model was off by 12% on labor hours; estimators were off by 15%." */
export function accuracySentences(r: AccuracyReport): string[] {
  const one = (what: string, model: number | null, est: number | null): string | null => {
    if (model !== null && est !== null) {
      return `On average the model was off by ${formatMape(model)} on ${what}; estimators' own numbers were off by ${formatMape(est)}.`;
    }
    if (model !== null) return `On average the model was off by ${formatMape(model)} on ${what}.`;
    if (est !== null) return `On average estimators' numbers were off by ${formatMape(est)} on ${what}.`;
    return null;
  };
  return [one('labor hours', r.hoursMapeModel, r.hoursMapeEstimator), one('material quantities', r.qtyMapeModel, r.qtyMapeEstimator)].filter(
    (s): s is string => s !== null,
  );
}

export interface RunMeta {
  trigger: 'cron' | 'manual' | null;
  actorId: string | null;
  /** Calibration: what happened to the candidate ('promoted', 'awaiting_approval', ...). */
  outcome: string | null;
  message: string | null;
}

/** The trigger, actor and outcome a nightly run stores in learning_runs.summary. */
export function parseRunMeta(summary: unknown): RunMeta {
  const s = asRecord(summary) ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    trigger: s.trigger === 'cron' || s.trigger === 'manual' ? s.trigger : null,
    actorId: str(s.actorId),
    outcome: str(s.outcome),
    message: str(s.message),
  };
}

export const OUTCOME_LABELS: Record<string, string> = {
  promoted: 'Promoted automatically',
  awaiting_approval: 'Waiting for approval',
  rejected: 'Rejected by a gate',
  no_change: 'No change',
  not_stored: 'Not stored',
};

export const outcomeLabel = (outcome: string | null) => (outcome ? (OUTCOME_LABELS[outcome] ?? capitalize(humanize(outcome))) : null);

/**
 * A run still marked 'running' long after it started never finished (timeout or crash); the next
 * run of that kind closes it. `staleMs` is lib/learning/nightlyCore's STALE_RUN_MS.
 */
export function isStalledRun(run: { status: string; started_at: string }, nowMs: number, staleMs: number): boolean {
  const started = Date.parse(run.started_at);
  return run.status === 'running' && Number.isFinite(started) && nowMs - started > staleMs;
}

export const RUN_KIND_LABELS: Record<string, string> = {
  calibration: 'Calibration',
  win_model: 'Win model',
  lead_model: 'Lead model',
  followup_stats: 'Follow-up stats',
  report: 'Report',
};

export const runKindLabel = (kind: string) => RUN_KIND_LABELS[kind] ?? capitalize(humanize(kind));

// ---------------------------------------------------------------------------
// Win rate
// ---------------------------------------------------------------------------

export interface WinBuckets {
  byMarkup: WinRateBucket[];
  byJobType: WinRateBucket[];
  bySource: WinRateBucket[];
}

function parseBucketList(v: unknown): WinRateBucket[] {
  if (!Array.isArray(v)) return [];
  const out: WinRateBucket[] = [];
  for (const item of v) {
    const b = asRecord(item);
    if (!b || typeof b.label !== 'string') continue;
    const quotes = finiteOrNull(b.quotes);
    const wins = finiteOrNull(b.wins);
    if (quotes === null || wins === null || quotes < 0 || wins < 0) continue;
    // Recomputed rather than trusted: a zero-quote bucket has no win rate to divide out.
    out.push({ label: b.label, quotes, wins, winRate: quotes > 0 ? wins / quotes : 0 });
  }
  return out;
}

export interface WinRunSummary {
  /** Usable decided quotes (the win model's training set). Null when the run did not record it. */
  nQuotes: number | null;
  decidedQuotes: number | null;
  trained: boolean;
  reason: string | null;
  buckets: WinBuckets | null;
}

/** A win_model run's summary: counts, why it did or did not train, and the win-rate buckets. */
export function parseWinRunSummary(summary: unknown): WinRunSummary {
  const s = asRecord(summary) ?? {};
  const b = asRecord(s.buckets);
  return {
    nQuotes: finiteOrNull(s.nQuotes),
    decidedQuotes: finiteOrNull(s.decidedQuotes),
    trained: s.trained === true,
    reason: typeof s.reason === 'string' && s.reason.trim() ? s.reason : null,
    buckets: b ? { byMarkup: parseBucketList(b.byMarkup), byJobType: parseBucketList(b.byJobType), bySource: parseBucketList(b.bySource) } : null,
  };
}

export interface WinMetrics {
  auc: number | null;
  logLoss: number | null;
  baseRate: number | null;
}

/** win_models.metrics ({auc, logLoss, baseRate}); anything missing is null. */
export function parseWinMetrics(metrics: unknown): WinMetrics {
  const m = asRecord(metrics) ?? {};
  return { auc: finiteOrNull(m.auc), logLoss: finiteOrNull(m.logLoss), baseRate: finiteOrNull(m.baseRate) };
}

/** Cold-start explanation shown while no win model is active. */
export function winColdStartMessage(minQuotes: number, nQuotes: number | null, reason: string | null = null): string {
  const need = `${formatCount(minQuotes)} decided ${plural(minQuotes, 'quote')}`;
  if (nQuotes === null) return `Price recommendations start after ${need}. The first nightly run will count yours.`;
  if (nQuotes < minQuotes) return `Price recommendations start after ${need} (you have ${formatCount(nQuotes)}).`;
  return `You have ${formatCount(nQuotes)} decided ${plural(nQuotes, 'quote')}, enough to train, but no price model is active yet${reason ? `: ${reason}` : '.'}`;
}

// ---------------------------------------------------------------------------
// Manual run result
// ---------------------------------------------------------------------------

/** True when any step of the run failed (mirrors summaryHasFailures in nightlyCore). */
export function nightlyHasFailures(s: NightlySummary): boolean {
  return s.expiredQuotes === null || s.calibration.status === 'failed' || s.winModel.status === 'failed' || s.deviationOutcomesUpdated === null;
}

function calibrationSentence(c: NightlySummary['calibration']): string {
  if (c.status === 'failed') return `Calibration failed: ${c.error ?? 'unknown error'}`;
  if (c.status === 'skipped') return `Calibration skipped: ${c.error ?? 'another run is in progress.'}`;
  const changed = `${c.changedCount} ${plural(c.changedCount, 'coefficient')} changed`;
  if (c.changedCount === 0) {
    return `Calibration: no coefficient moved (${c.jobsUsed} of ${c.jobsConsidered} completed ${plural(c.jobsConsidered, 'job')} usable).`;
  }
  if (c.promoted) return `Calibration: ${changed}; every gate passed and the new set was promoted automatically.`;
  const failed = c.gates.filter((g) => !g.passed);
  const failedNames = failed.map((g) => GATE_LABELS[g.name]).join(', ');
  if (!c.candidateSetId) return `Calibration: ${changed}, but the candidate was not stored (${failedNames || 'sanity check'} failed).`;
  if (failed.length) return `Calibration: ${changed}, but the candidate was rejected (failed: ${failedNames}).`;
  return `Calibration: ${changed}; the candidate is waiting for your approval.`;
}

function winModelSentence(w: NightlySummary['winModel']): string {
  if (w.status === 'failed') return `Win model failed: ${w.error ?? 'unknown error'}`;
  if (w.status === 'skipped') return `Win model skipped: ${w.error ?? w.reason}`;
  if (w.trained) return `Win model retrained on ${w.nQuotes} decided ${plural(w.nQuotes, 'quote')}.`;
  return `Win model not trained: ${w.reason}`;
}

/** One status line for the "Run learning now" button. ok is false when any step failed. */
export function nightlyResultMessage(s: NightlySummary): { ok: boolean; message: string } {
  const parts = [calibrationSentence(s.calibration), winModelSentence(s.winModel)];
  if (s.expiredQuotes === null) parts.push('Expiring stale quotes failed.');
  else if (s.expiredQuotes > 0) parts.push(`${s.expiredQuotes} stale ${plural(s.expiredQuotes, 'quote')} expired.`);
  if (s.deviationOutcomesUpdated === null) parts.push('Scoring deviation flags failed.');
  else if (s.deviationOutcomesUpdated > 0) {
    parts.push(`${s.deviationOutcomesUpdated} deviation ${plural(s.deviationOutcomesUpdated, 'flag')} scored against actuals.`);
  }
  const ok = !nightlyHasFailures(s);
  return { ok, message: `${ok ? 'Learning run finished.' : 'Learning run finished with problems.'} ${parts.join(' ')}` };
}

// ---------------------------------------------------------------------------
// Set history
// ---------------------------------------------------------------------------

export const SET_STATUS_LABELS: Record<SetStatus, string> = {
  candidate: 'Candidate',
  active: 'Active',
  superseded: 'Superseded',
  rejected: 'Rejected',
};

export const SET_STATUS_TONES: Record<SetStatus, 'amber' | 'green' | 'slate' | 'red'> = {
  candidate: 'amber',
  active: 'green',
  superseded: 'slate',
  rejected: 'red',
};

export const SET_SOURCE_LABELS: Record<string, string> = {
  seed: 'Starting priors',
  nightly: 'Nightly run',
  manual: 'Manual',
  rollback: 'Restored copy',
};

export const setSourceLabel = (source: string) => SET_SOURCE_LABELS[source] ?? capitalize(humanize(source));

/** Only past sets can be restored: the active set already prices, a candidate is approved instead. */
export const canRestore = (status: SetStatus) => status === 'superseded' || status === 'rejected';

// ---------------------------------------------------------------------------
// Owner actions: forms and the notice shown after a redirect
// ---------------------------------------------------------------------------

const REASON_MAX = 500;

export const approveForm = z.object({
  set_id: uuidField('Candidate set'),
  reason: optionalTextField('Reason', REASON_MAX),
});

/** Reject and restore both need a reason for the changelog and audit log. */
export const decisionForm = z.object({
  set_id: uuidField('Coefficient set'),
  reason: textField('Reason', REASON_MAX),
});

export type NoticeKind = 'approved' | 'rejected' | 'restored';

export interface LearningNotice {
  kind: NoticeKind;
  /** The set the action produced (approved / restored) or decided (rejected). */
  version: number | null;
  /** Restore only: the version that was copied. */
  from: number | null;
}

/** Query string carried by the redirect after an owner decision. */
export function noticeQuery(n: LearningNotice): string {
  const q = new URLSearchParams({ notice: n.kind });
  if (n.version !== null) q.set('v', String(n.version));
  if (n.from !== null) q.set('from', String(n.from));
  return `?${q.toString()}`;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function versionParam(v: string | string[] | undefined): number | null {
  const s = first(v);
  return s !== undefined && /^\d{1,9}$/.test(s) ? Number(s) : null;
}

/** The notice from the page's search params; anything unexpected is ignored, never echoed. */
export function parseNotice(params: Record<string, string | string[] | undefined>): LearningNotice | null {
  const kind = first(params.notice);
  if (kind !== 'approved' && kind !== 'rejected' && kind !== 'restored') return null;
  return { kind, version: versionParam(params.v), from: kind === 'restored' ? versionParam(params.from) : null };
}

export function noticeMessage(n: LearningNotice): string {
  const v = n.version !== null ? ` v${n.version}` : '';
  switch (n.kind) {
    case 'approved':
      return `Candidate${v} approved. It is now the active set; estimators pick it up the next time their app syncs.`;
    case 'rejected':
      return `Candidate${v} rejected. Pricing keeps using the active set.`;
    case 'restored':
      return `${n.from !== null ? `Version ${n.from} restored` : 'Version restored'}${n.version !== null ? ` as v${n.version}` : ''}. Pricing uses it now; estimators pick it up the next time their app syncs.`;
  }
}

// ---------------------------------------------------------------------------
// Sparkline (inline SVG)
// ---------------------------------------------------------------------------

export interface Sparkline {
  /** SVG path data; a null value breaks the line. */
  path: string;
  points: Array<{ x: number; y: number; value: number; index: number }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Line through `values` in a width x height box (oldest first). Nulls and non-finite values leave
 * a gap. `zeroBased` starts the scale at 0 so small errors are not exaggerated; `domain` widens the
 * scale to include those values, so several lines can share one. Null when there is nothing to draw.
 */
export function sparkline(
  values: ReadonlyArray<number | null>,
  opts: { width: number; height: number; pad?: number; zeroBased?: boolean; domain?: readonly [number, number] },
): Sparkline | null {
  const pad = opts.pad ?? 2;
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!finite.length) return null;
  const extra = (opts.domain ?? []).filter((v) => Number.isFinite(v));
  let min = Math.min(...finite, ...extra);
  const max = Math.max(...finite, ...extra);
  if (opts.zeroBased) min = Math.min(0, min);
  const innerW = Math.max(0, opts.width - 2 * pad);
  const innerH = Math.max(0, opts.height - 2 * pad);
  const x = (i: number) => (values.length > 1 ? pad + (i * innerW) / (values.length - 1) : opts.width / 2);
  const y = (v: number) => (max === min ? opts.height / 2 : pad + (1 - (v - min) / (max - min)) * innerH);

  const points: Sparkline['points'] = [];
  let path = '';
  let penDown = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      penDown = false;
      return;
    }
    const p = { x: r2(x(i)), y: r2(y(v)), value: v, index: i };
    points.push(p);
    path += `${path ? ' ' : ''}${penDown ? 'L' : 'M'}${p.x} ${p.y}`;
    penDown = true;
  });
  return { path, points };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

export const formatCount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

const DASH = '—';
const MINUS = '−';

/** A coefficient value to 4 significant digits: 1.1, 0.004, 0.1523. */
export function formatCoef(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return String(Number(v.toPrecision(4)));
}

/** Signed percent change: "+12.3%", "−4.0%", "0%". */
export function formatSignedPct(p: number | null | undefined, digits = 1): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return DASH;
  const r = Number((p * 100).toFixed(digits));
  if (r === 0) return '0%';
  return `${r > 0 ? '+' : MINUS}${Math.abs(r).toFixed(digits)}%`;
}

/** A fraction as a percent: 0.625 -> "63%". */
export function formatPct(p: number | null | undefined, digits = 0): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return DASH;
  return `${(p * 100).toFixed(digits)}%`;
}

/** Mean absolute percentage error: whole percent from 10% up, one decimal below. */
export function formatMape(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return DASH;
  const pct = m * 100;
  return pct >= 10 ? `${Math.round(pct)}%` : `${Number(pct.toFixed(1))}%`;
}

/** "± 0.0123" for a standard error. */
export function formatStdError(se: number | null | undefined): string {
  if (se === null || se === undefined || !Number.isFinite(se)) return DASH;
  return `± ${formatCoef(Math.abs(se))}`;
}

/** n_eff to one decimal. */
export function formatNEff(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** Confidence (0..100) clamped and rounded, for the bar width and its label. */
export function confidencePct(c: number | null | undefined): number {
  if (c === null || c === undefined || !Number.isFinite(c)) return 0;
  return Math.round(Math.min(100, Math.max(0, c)));
}

/** A model metric to 2 decimals (AUC, log loss). */
export function formatMetric(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toFixed(2);
}

const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, year: 'numeric', month: 'short', day: 'numeric' });

// Newer ICU puts a narrow no-break space before AM/PM; plain spaces keep output stable everywhere.
const clean = (s: string) => s.replace(/[  ]/g, ' ');

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "Oct 20, 2026, 2:15 AM" in Eastern time; "—" when missing or invalid. */
export function formatDateTime(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? clean(dateTimeFmt.format(d)) : DASH;
}

/** "Oct 20, 2026" in Eastern time. */
export function formatDate(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? clean(dateFmt.format(d)) : DASH;
}

/** How long a run took: "42 s", "3 min 5 s", "1 h 2 min"; null when it has not finished. */
export function formatDuration(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  const a = toDate(startIso);
  const b = toDate(endIso);
  if (!a || !b) return null;
  const s = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

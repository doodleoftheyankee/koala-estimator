// Database adapter for the nightly learning job (PLAN.md §6.7): the only part of lib/learning
// that talks to Postgres. Every function takes a service-role client (RLS is bypassed, so callers
// must be trusted server code), reads in pages so nothing is truncated at PostgREST's row cap,
// and parses rows at the boundary with the schemas in nightlyCore.ts.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WinModel } from '@/lib/pricing';
import {
  activeSetRowSchema,
  actualDbRowSchema,
  areaRowSchema,
  assembleJobsForLearning,
  candidateSetRow,
  chunk,
  coefficientRow,
  coefficientRowSchema,
  completedJobRowSchema,
  decideEstimates,
  estimateDriveRowSchema,
  flagRowSchema,
  idRowSchema,
  jobRowSchema,
  leadRowSchema,
  leadSourceRowSchema,
  learningQuoteRowSchema,
  lineFlagOutcomes,
  outcomeEstimateRowSchema,
  outcomeQuoteRowSchema,
  parseOutcomeSnapshot,
  parseRows,
  STALE_RUN_MS,
  toStoredCoefficient,
  verifiedActualsByJob,
  winModelRow,
  type ActiveCoefficients,
  type RunFinish,
  type RunKind,
} from './nightlyCore';
import type { JobForLearning, QuoteOutcomeRow } from './observations';
import { parseLearningSettings } from './settings';
import type { CalibrationResult, DeviationOutcome, LearningSettings } from './types';

/** Rows requested per page. The loop advances by rows received, so a lower server cap is safe. */
const PAGE = 1000;
/** Ids per `in (...)` filter, keeping request URLs well under proxy limits. */
const IN_CHUNK = 100;

const ACTUAL_COLUMNS =
  'id, job_id, area_id, product, actual_material_qty, actual_hours, actual_drive_minutes, verified_at, exclude_from_learning';

type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

/** Every row of a query, page by page (ordered by a unique key so pages do not overlap). */
async function fetchAll(what: string, page: (from: number, to: number) => Page): Promise<unknown[]> {
  const out: unknown[] = [];
  for (;;) {
    const { data, error } = await page(out.length, out.length + PAGE - 1);
    if (error) throw new Error(`Loading ${what} failed: ${error.message}`);
    if (!data || data.length === 0) return out;
    out.push(...data);
  }
}

/** fetchAll over `ids`, IN_CHUNK ids per filter. */
async function fetchIn(
  what: string,
  ids: readonly string[],
  page: (ids: string[], from: number, to: number) => Page,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const part of chunk([...new Set(ids)], IN_CHUNK)) out.push(...(await fetchAll(what, (from, to) => page(part, from, to))));
  return out;
}

function check(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Settings, runs
// ---------------------------------------------------------------------------

/** app_settings.learning with defaults for anything missing or out of range. */
export async function loadLearningSettings(admin: SupabaseClient): Promise<LearningSettings> {
  const { data, error } = await admin.from('app_settings').select('value').eq('key', 'learning').maybeSingle();
  check('Loading learning settings', error);
  return parseLearningSettings((data as { value?: unknown } | null)?.value);
}

/**
 * Opens a learning_runs row (status 'running'). Runs of this kind that never finished within
 * STALE_RUN_MS (function timeout, crash) are closed as failed first; if one is still running
 * (a duplicate cron delivery or a manual run), returns null instead of starting another.
 */
export async function startRun(admin: SupabaseClient, kind: RunKind, summary: Record<string, unknown>): Promise<string | null> {
  const nowMs = Date.now();
  const stale = await admin
    .from('learning_runs')
    .update({ status: 'failed', finished_at: new Date(nowMs).toISOString(), error: 'Did not finish (timed out or crashed).' })
    .eq('kind', kind)
    .eq('status', 'running')
    .lt('started_at', new Date(nowMs - STALE_RUN_MS).toISOString());
  check('Closing stale learning runs', stale.error);

  const running = await admin
    .from('learning_runs')
    .select('id', { count: 'exact', head: true })
    .eq('kind', kind)
    .eq('status', 'running');
  check('Checking for running learning runs', running.error);
  if ((running.count ?? 0) > 0) return null;

  const { data, error } = await admin.from('learning_runs').insert({ kind, status: 'running', summary }).select('id').single();
  check('Starting the learning run', error);
  return idRowSchema.parse(data).id;
}

export async function finishRun(admin: SupabaseClient, runId: string, f: RunFinish): Promise<void> {
  const { error } = await admin
    .from('learning_runs')
    .update({
      status: f.status,
      finished_at: new Date().toISOString(),
      jobs_considered: f.jobsConsidered,
      jobs_used: f.jobsUsed,
      candidate_set_id: f.candidateSetId,
      promoted: f.promoted,
      summary: f.summary,
      error: f.error,
    })
    .eq('id', runId);
  check('Recording the learning run', error);
}

// ---------------------------------------------------------------------------
// Coefficients
// ---------------------------------------------------------------------------

export async function loadActiveSetId(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin.from('coefficient_sets').select('id').eq('status', 'active').maybeSingle();
  check('Loading the active coefficient set', error);
  return data ? idRowSchema.parse(data).id : null;
}

/** The active coefficient set with guardrail bounds and evidence. Throws when none is active. */
export async function loadActiveCoefficients(admin: SupabaseClient): Promise<ActiveCoefficients> {
  const { data, error } = await admin.from('coefficient_sets').select('id, version').eq('status', 'active').maybeSingle();
  check('Loading the active coefficient set', error);
  if (!data) throw new Error('There is no active coefficient set.');
  const set = activeSetRowSchema.parse(data);
  const rows = await fetchAll('coefficients', (from, to) =>
    admin
      .from('coefficients')
      .select('id, kind, product, job_type, access_level, value, prior_value, lower_bound, upper_bound, sample_size, n_eff, confidence')
      .eq('set_id', set.id)
      .order('id')
      .range(from, to),
  );
  return {
    setId: set.id,
    version: set.version,
    coefficients: parseRows(coefficientRowSchema, rows, 'coefficient').map(toStoredCoefficient),
  };
}

/**
 * Stores a candidate set and its coefficients (status 'candidate', source 'nightly'), then marks
 * older nightly candidates rejected so only the newest waits for approval. If the coefficients
 * cannot be stored, the empty set is removed again. Returns the new set id.
 */
export async function insertCandidateSet(
  admin: SupabaseClient,
  args: { runId: string; parentSetId: string; result: CalibrationResult },
): Promise<string> {
  const { data, error } = await admin.from('coefficient_sets').insert(candidateSetRow(args)).select('id').single();
  check('Storing the candidate set', error);
  const setId = idRowSchema.parse(data).id;

  try {
    const rows = args.result.coefficients.map((c) => coefficientRow(setId, c));
    for (const part of chunk(rows, 500)) {
      const ins = await admin.from('coefficients').insert(part);
      check('Storing candidate coefficients', ins.error);
    }
  } catch (e) {
    const cleanup = await admin.from('coefficient_sets').delete().eq('id', setId);
    if (cleanup.error) console.error('[nightly] removing the incomplete candidate failed', cleanup.error.message);
    throw e;
  }

  const older = await admin
    .from('coefficient_sets')
    .update({ status: 'rejected', notes: 'Replaced by a newer nightly candidate' })
    .eq('status', 'candidate')
    .eq('source', 'nightly')
    .neq('id', setId);
  check('Retiring older nightly candidates', older.error);
  return setId;
}

/** Atomic swap through promote_coefficient_set() (old active -> superseded, changelog written). */
export async function promoteSet(admin: SupabaseClient, setId: string, reason: string): Promise<void> {
  const { error } = await admin.rpc('promote_coefficient_set', { p_set_id: setId, p_reason: reason });
  check('Promoting the candidate set', error);
}

/** A candidate that failed a gate (PLAN.md §6.4.5), through reject_coefficient_set(). */
export async function rejectSet(admin: SupabaseClient, setId: string, reason: string): Promise<void> {
  const { error } = await admin.rpc('reject_coefficient_set', { p_set_id: setId, p_reason: reason });
  check('Rejecting the candidate set', error);
}

// ---------------------------------------------------------------------------
// Jobs and actuals
// ---------------------------------------------------------------------------

/**
 * Completed jobs whose actuals are all verified (and at least one exists), with the frozen quote
 * snapshot and signed tier, estimate_areas and the estimate's drive time as fallbacks for quotes
 * that predate snapshot.input. Excluded actuals are left out of each job's rows.
 */
export async function loadJobsForLearning(admin: SupabaseClient): Promise<JobForLearning[]> {
  const jobs = parseRows(
    jobRowSchema,
    await fetchAll('completed jobs', (from, to) =>
      admin.from('jobs').select('id, quote_id, estimate_id, completed_at').eq('status', 'completed').order('id').range(from, to),
    ),
    'job',
  );
  if (!jobs.length) return [];

  const actuals = parseRows(
    actualDbRowSchema,
    await fetchIn('job actuals', jobs.map((j) => j.id), (ids, from, to) =>
      admin.from('job_actuals').select(ACTUAL_COLUMNS).in('job_id', ids).order('id').range(from, to),
    ),
    'job_actuals',
  );
  const verified = verifiedActualsByJob(actuals);
  const ready = jobs.filter((j) => verified.has(j.id));
  if (!ready.length) return [];

  const estimateIds = ready.map((j) => j.estimate_id);
  const [quotes, areas, estimates] = await Promise.all([
    fetchIn('signed quotes', ready.map((j) => j.quote_id), (ids, from, to) =>
      admin.from('quotes').select('id, signed_tier, snapshot').in('id', ids).order('id').range(from, to),
    ),
    fetchIn('estimate areas', estimateIds, (ids, from, to) =>
      admin
        .from('estimate_areas')
        .select('id, estimate_id, name, job_type, access_level, sqft')
        .in('estimate_id', ids)
        .order('id')
        .range(from, to),
    ),
    fetchIn('estimates', estimateIds, (ids, from, to) =>
      admin.from('estimates').select('id, drive_minutes_est').in('id', ids).order('id').range(from, to),
    ),
  ]);

  return assembleJobsForLearning({
    jobs: ready,
    actuals,
    quotes: parseRows(learningQuoteRowSchema, quotes, 'quote'),
    areas: parseRows(areaRowSchema, areas, 'estimate_areas'),
    estimates: parseRows(estimateDriveRowSchema, estimates, 'estimate'),
  });
}

// ---------------------------------------------------------------------------
// Quote outcomes and the win model
// ---------------------------------------------------------------------------

/**
 * One row per decided estimate (see decideEstimates): won, lost, or its latest quote expired or
 * declined, with the lead source name and the deciding quote's snapshot.
 */
export async function loadDecidedQuotes(admin: SupabaseClient): Promise<QuoteOutcomeRow[]> {
  const quotes = parseRows(
    outcomeQuoteRowSchema,
    await fetchAll('quotes', (from, to) =>
      admin
        .from('quotes')
        .select('id, estimate_id, version, status, signed_at, signed_tier, expires_at')
        .order('id')
        .range(from, to),
    ),
    'quote',
  );
  if (!quotes.length) return [];

  const estimates = parseRows(
    outcomeEstimateRowSchema,
    await fetchIn('estimates', quotes.map((q) => q.estimate_id), (ids, from, to) =>
      admin.from('estimates').select('id, status, decided_at, lead_id').in('id', ids).order('id').range(from, to),
    ),
    'estimate',
  );
  const leadIds = estimates.map((e) => e.lead_id).filter((x): x is string => x !== null);
  const [leads, sources] = await Promise.all([
    fetchIn('leads', leadIds, (ids, from, to) =>
      admin.from('leads').select('id, source_id').in('id', ids).order('id').range(from, to),
    ),
    fetchAll('lead sources', (from, to) => admin.from('lead_sources').select('id, name').order('id').range(from, to)),
  ]);

  const decided = decideEstimates({
    quotes,
    estimates,
    leads: parseRows(leadRowSchema, leads, 'lead'),
    sources: parseRows(leadSourceRowSchema, sources, 'lead_sources'),
  });
  if (!decided.length) return [];

  // Snapshots are large; load only the deciding version of each decided estimate.
  const snapshots = new Map(
    parseRows(
      learningQuoteRowSchema,
      await fetchIn('quote snapshots', decided.map((d) => d.quoteId), (ids, from, to) =>
        admin.from('quotes').select('id, signed_tier, snapshot').in('id', ids).order('id').range(from, to),
      ),
      'quote',
    ).map((q) => [q.id, q.snapshot]),
  );
  return decided.map((d) => ({
    estimateId: d.estimateId,
    won: d.won,
    decidedAt: d.decidedAt,
    source: d.source,
    signedTier: d.signedTier,
    snapshot: parseOutcomeSnapshot(snapshots.get(d.quoteId)),
  }));
}

/**
 * Stores a trained win model and makes it the active one. The partial unique index allows one
 * active row, so the new row is inserted inactive, the old one switched off, then the new on.
 */
export async function insertWinModel(admin: SupabaseClient, runId: string, model: Omit<WinModel, 'id' | 'trainedAt'>): Promise<string> {
  const { data, error } = await admin.from('win_models').insert(winModelRow(runId, model)).select('id').single();
  check('Storing the win model', error);
  const id = idRowSchema.parse(data).id;
  const off = await admin.from('win_models').update({ is_active: false }).eq('is_active', true).neq('id', id);
  check('Deactivating the previous win model', off.error);
  const on = await admin.from('win_models').update({ is_active: true }).eq('id', id);
  check('Activating the win model', on.error);
  return id;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Settles open line deviation flags (qty/hours) on estimates whose job is completed and fully
 * verified: who was closer to the crew's actual, the estimator or the model? Returns how many
 * flags got an outcome. Only rows still without an outcome are written, so reruns are no-ops.
 */
export async function updateDeviationOutcomes(admin: SupabaseClient): Promise<number> {
  const flags = parseRows(
    flagRowSchema,
    await fetchAll('deviation flags', (from, to) =>
      admin
        .from('deviation_flags')
        .select('id, estimate_id, flag_key, metric, estimator_value, model_value')
        .is('outcome', null)
        .in('metric', ['qty', 'hours'])
        .not('flag_key', 'is', null)
        .order('id')
        .range(from, to),
    ),
    'deviation_flags',
  );
  if (!flags.length) return 0;

  const jobs = parseRows(
    completedJobRowSchema,
    await fetchIn('completed jobs', flags.map((f) => f.estimate_id), (ids, from, to) =>
      admin
        .from('jobs')
        .select('id, estimate_id, completed_at')
        .eq('status', 'completed')
        .in('estimate_id', ids)
        .order('id')
        .range(from, to),
    ),
    'job',
  );
  if (!jobs.length) return 0;
  const actuals = parseRows(
    actualDbRowSchema,
    await fetchIn('job actuals', jobs.map((j) => j.id), (ids, from, to) =>
      admin.from('job_actuals').select(ACTUAL_COLUMNS).in('job_id', ids).order('id').range(from, to),
    ),
    'job_actuals',
  );

  const byOutcome = new Map<DeviationOutcome, string[]>();
  for (const { id, outcome } of lineFlagOutcomes(flags, jobs, actuals)) {
    byOutcome.set(outcome, [...(byOutcome.get(outcome) ?? []), id]);
  }
  let updated = 0;
  for (const [outcome, ids] of byOutcome) {
    for (const part of chunk(ids, IN_CHUNK)) {
      const { data, error } = await admin.from('deviation_flags').update({ outcome }).in('id', part).is('outcome', null).select('id');
      check('Recording deviation outcomes', error);
      updated += data?.length ?? 0;
    }
  }
  return updated;
}

/** expire_stale_quotes(): sent/viewed quotes past expires_at become 'expired' with their estimate. */
export async function expireStaleQuotes(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc('expire_stale_quotes');
  check('Expiring stale quotes', error);
  const n = Number(data);
  return Number.isFinite(n) ? n : 0;
}

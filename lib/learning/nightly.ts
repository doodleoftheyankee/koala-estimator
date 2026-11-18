// The nightly learning job (PLAN.md §6): run by app/api/cron/nightly (Vercel Cron) or manually by
// the owner. The steps and their rules live in nightlyCore.ts (unit tested); this file wires them
// to the database (io.ts) and to email.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '@/lib/env';
import { LOCATION_COLUMNS, parseLocation } from '@/lib/locations/location';
import { sendEmail } from '@/lib/quotes/email';
import type { AccuracyReport } from './accuracy';
import * as io from './io';
import { runNightlyWith } from './nightlyCore';
import type { BacktestMetrics, GateResult, WinRateBucket } from './types';

export interface NightlySummary {
  startedAt: string;
  finishedAt: string;
  trigger: 'cron' | 'manual';
  expiredQuotes: number | null;
  calibration: {
    runId: string | null;
    status: 'succeeded' | 'failed' | 'skipped';
    jobsConsidered: number;
    jobsUsed: number;
    candidateSetId: string | null;
    changedCount: number;
    promoted: boolean;
    gates: GateResult[];
    holdout: BacktestMetrics | null;
    accuracy: AccuracyReport | null;
    error: string | null;
  };
  winModel: {
    runId: string | null;
    status: 'succeeded' | 'failed' | 'skipped';
    nQuotes: number;
    trained: boolean;
    reason: string;
    buckets: { byMarkup: WinRateBucket[]; byJobType: WinRateBucket[]; bySource: WinRateBucket[] } | null;
    error: string | null;
  };
  deviationOutcomesUpdated: number | null;
}

/**
 * The nightly learning job (PLAN.md §6) for one store. Every step is isolated: a failure is
 * recorded in learning_runs and the summary, the active coefficient set is never touched by a
 * failed step, and later steps still run. `admin` must be a service-role client. Only this store's
 * jobs and quotes are read, and only this store's coefficients and win model change.
 */
export async function runNightly(
  admin: SupabaseClient,
  now: Date,
  opts: { trigger: 'cron' | 'manual'; actorId?: string; locationId: string },
): Promise<NightlySummary> {
  const { data, error } = await admin.from('locations').select(LOCATION_COLUMNS).eq('id', opts.locationId).single();
  if (error) throw new Error(`Loading the store failed: ${error.message}`);
  const location = parseLocation(data);
  const loc = location.id;
  return runNightlyWith(
    {
      loadSettings: () => io.loadLearningSettings(admin, loc),
      expireStaleQuotes: () => io.expireStaleQuotes(admin),
      startRun: (kind, summary) => io.startRun(admin, loc, kind, summary),
      finishRun: (runId, finish) => io.finishRun(admin, runId, finish),
      loadActiveCoefficients: () => io.loadActiveCoefficients(admin, loc),
      loadActiveSetId: () => io.loadActiveSetId(admin, loc),
      loadJobsForLearning: () => io.loadJobsForLearning(admin, loc),
      insertCandidateSet: (args) => io.insertCandidateSet(admin, loc, args),
      rejectSet: (setId, reason) => io.rejectSet(admin, setId, reason),
      promoteSet: (setId, reason) => io.promoteSet(admin, setId, reason),
      loadDecidedQuotes: () => io.loadDecidedQuotes(admin, loc),
      insertWinModel: (runId, model) => io.insertWinModel(admin, loc, runId, model),
      updateDeviationOutcomes: () => io.updateDeviationOutcomes(admin, loc),
      ownerEmail: location.ownerReportEmail ?? serverEnv.ownerReportEmail(),
      sendEmail: (msg) => sendEmail({ ...msg, from: location.quoteFromEmail ?? undefined }),
      timeZone: location.timeZone,
      storeName: location.name,
      clock: () => new Date(),
      log: (message) => console.error(`${message} (${location.shortName})`),
    },
    now,
    opts,
  );
}

/** The cron: every active store in turn. One store's failure never stops the next store's run. */
export async function runNightlyAllStores(
  admin: SupabaseClient,
  now: Date,
): Promise<Array<{ locationId: string; name: string; summary: NightlySummary | null; error: string | null }>> {
  const { data, error } = await admin.from('locations').select('id, name').eq('active', true).order('created_at');
  if (error) throw new Error(`Loading the stores failed: ${error.message}`);
  const out: Array<{ locationId: string; name: string; summary: NightlySummary | null; error: string | null }> = [];
  for (const store of (data ?? []) as Array<{ id: string; name: string }>) {
    try {
      out.push({ locationId: store.id, name: store.name, summary: await runNightly(admin, now, { trigger: 'cron', locationId: store.id }), error: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[nightly] ${store.name} failed`, message);
      out.push({ locationId: store.id, name: store.name, summary: null, error: message });
    }
  }
  return out;
}

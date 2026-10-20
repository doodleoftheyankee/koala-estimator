// The nightly learning job (PLAN.md §6): run by app/api/cron/nightly (Vercel Cron) or manually by
// the owner. The steps and their rules live in nightlyCore.ts (unit tested); this file wires them
// to the database (io.ts) and to email.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '@/lib/env';
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
 * The nightly learning job (PLAN.md §6). Every step is isolated: a failure is recorded in
 * learning_runs and the summary, the active coefficient set is never touched by a failed
 * step, and later steps still run. `admin` must be a service-role client.
 */
export async function runNightly(
  admin: SupabaseClient,
  now: Date,
  opts: { trigger: 'cron' | 'manual'; actorId?: string },
): Promise<NightlySummary> {
  return runNightlyWith(
    {
      loadSettings: () => io.loadLearningSettings(admin),
      expireStaleQuotes: () => io.expireStaleQuotes(admin),
      startRun: (kind, summary) => io.startRun(admin, kind, summary),
      finishRun: (runId, finish) => io.finishRun(admin, runId, finish),
      loadActiveCoefficients: () => io.loadActiveCoefficients(admin),
      loadActiveSetId: () => io.loadActiveSetId(admin),
      loadJobsForLearning: () => io.loadJobsForLearning(admin),
      insertCandidateSet: (args) => io.insertCandidateSet(admin, args),
      rejectSet: (setId, reason) => io.rejectSet(admin, setId, reason),
      promoteSet: (setId, reason) => io.promoteSet(admin, setId, reason),
      loadDecidedQuotes: () => io.loadDecidedQuotes(admin),
      insertWinModel: (runId, model) => io.insertWinModel(admin, runId, model),
      updateDeviationOutcomes: () => io.updateDeviationOutcomes(admin),
      ownerEmail: serverEnv.ownerReportEmail(),
      sendEmail: (msg) => sendEmail(msg),
      clock: () => new Date(),
      log: (message) => console.error(message),
    },
    now,
    opts,
  );
}

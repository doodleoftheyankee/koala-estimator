// SKELETON: replaced by the implementation. Signatures are the contract.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccuracyReport } from './accuracy';
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
  void admin;
  void now;
  void opts;
  throw new Error('not implemented');
}

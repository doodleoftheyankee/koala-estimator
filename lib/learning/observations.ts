// SKELETON: replaced by the implementation. Signatures are the contract.
import type { AccessLevel, JobType, ProductCode, Tier } from '@/lib/pricing';
import type { DriveObservation, Observation, QuoteSnapshotForLearning, WinObservation } from './types';

export interface ActualRow {
  areaId: string | null; // null = job-level row (drive minutes, days, crew size)
  product: ProductCode | null;
  actualMaterialQty: number | null;
  actualHours: number | null;
  actualDriveMinutes: number | null;
}

export interface JobForLearning {
  jobId: string;
  completedAt: string;
  signedTier: Tier;
  snapshot: QuoteSnapshotForLearning;
  /** From estimate_areas; used only when the snapshot predates `snapshot.input`. */
  areasFallback: Array<{ id: string; name: string; jobType: JobType; accessLevel: AccessLevel; sqft: number }>;
  /** Verified, not excluded actuals for this job. */
  actuals: ActualRow[];
  /** estimates.drive_minutes_est, used when the snapshot has no input. */
  driveMinutesEstFallback: number | null;
}

/** One Observation per area x product that has both a priced line and an actual. */
export function observationsFromJob(job: JobForLearning): { observations: Observation[]; drive: DriveObservation | null } {
  void job;
  throw new Error('not implemented');
}

export interface QuoteOutcomeRow {
  estimateId: string;
  won: boolean;
  decidedAt: string;
  source: string | null;
  snapshot: {
    document?: { recommendedTier?: Tier | null };
    options?: QuoteSnapshotForLearning['options'];
    input?: QuoteSnapshotForLearning['input'];
  };
  signedTier: Tier | null;
}

/**
 * The win model's view of one decided estimate (its latest quote): markup and price of the
 * recommended option (falling back to 'better', then the first option), primary job type
 * (largest area), total sqft. Null when the snapshot lacks what is needed.
 */
export function winObservationFromQuote(row: QuoteOutcomeRow): WinObservation | null {
  void row;
  throw new Error('not implemented');
}

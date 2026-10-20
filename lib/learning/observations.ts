// Turns completed jobs and decided quotes into the plain rows the learning loop fits on.
// Everything comes from the frozen quote snapshot (what was actually priced and sent), never
// from the editable estimate, plus verified job actuals. Pure.
import type { AccessLevel, JobType, PricedLine, PricedOption, ProductCode, Tier } from '@/lib/pricing';
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
  return { observations: areaObservations(job), drive: driveObservation(job) };
}

function areaObservations(job: JobForLearning): Observation[] {
  // Only the option the customer signed was installed.
  const option = job.snapshot.options.find((o) => o.tier === job.signedTier);
  if (!option) return [];
  const areas = new Map((job.snapshot.input?.areas ?? job.areasFallback).map((a) => [a.id, a]));

  const out: Observation[] = [];
  for (const row of job.actuals) {
    if (!row.areaId || !row.product) continue;
    const area = areas.get(row.areaId);
    if (!area) continue;
    const material = findLine(option, row.areaId, row.product, 'material');
    // Removal hours live on the removal line; every other product's hours on its labor line.
    const hoursLine = findLine(option, row.areaId, row.product, row.product === 'removal' ? 'removal' : 'labor');
    if (!material && !hoursLine) continue;
    out.push({
      jobId: job.jobId,
      areaId: row.areaId,
      completedAt: job.completedAt,
      product: row.product,
      jobType: area.jobType,
      accessLevel: area.accessLevel,
      sqft: area.sqft,
      designQty: num(material?.designQty),
      modelQty: num(material?.modelQty),
      estQty: num(material?.qty),
      modelHours: num(hoursLine?.modelHours),
      estHours: num(hoursLine?.hours),
      actualQty: num(row.actualMaterialQty),
      actualHours: num(row.actualHours),
    });
  }
  return out;
}

/** The crew's one-way drive time against the estimate used at quote time. Independent of the tier. */
function driveObservation(job: JobForLearning): DriveObservation | null {
  const actual = job.actuals
    .filter((r) => r.areaId === null)
    .map((r) => num(r.actualDriveMinutes))
    .find((m) => m !== null && m > 0);
  const est = num(job.snapshot.input?.driveMinutesOneWay ?? job.driveMinutesEstFallback);
  if (actual === undefined || actual === null || est === null || est <= 0) return null;
  return { jobId: job.jobId, completedAt: job.completedAt, estMinutes: est, actualMinutes: actual };
}

function findLine(option: PricedOption, areaId: string, product: ProductCode, kind: PricedLine['kind']): PricedLine | undefined {
  return option.lines.find((l) => l.kind === kind && l.areaId === areaId && l.product === product);
}

/** Finite number or null (snapshot JSON from older versions may lack fields). */
function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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
  const options = row.snapshot.options ?? [];
  const recommended = row.snapshot.document?.recommendedTier ?? null;
  const option =
    options.find((o) => o.tier === recommended) ?? options.find((o) => o.tier === 'better') ?? options[0];
  if (!option) return null;
  const loadedCost = num(option.loadedCost);
  const price = num(option.price);
  if (loadedCost === null || loadedCost <= 0 || price === null || price <= 0) return null;

  const areas = row.snapshot.input?.areas ?? [];
  // The largest area decides the job type (first one on a tie).
  const primary = areas.reduce<(typeof areas)[number] | null>((best, a) => (!best || a.sqft > best.sqft ? a : best), null);
  const sqft = areas.reduce((acc, a) => acc + (num(a.sqft) ?? 0), 0);

  return {
    estimateId: row.estimateId,
    won: row.won,
    decidedAt: row.decidedAt,
    markup: price / loadedCost,
    price,
    jobType: primary?.jobType ?? 'unknown',
    source: row.source,
    sqft,
  };
}

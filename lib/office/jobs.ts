// The office jobs list (/jobs): which stage a job is in, in the one status vocabulary, the stage
// filter, and what the figures at the top count. Pure.
//
// Stages are the job badges (components/daymark StatusBadge, jobBadgeStatus):
//   To schedule  signed, no start date yet          Scheduled    has a start date
//   In progress  the crew has started                Needs check  done; actuals to check
//   Verified     done and every actuals row checked   Cancelled    will not go ahead
// The list shows the stages that need the office first. To schedule, Needs check, In progress and
// Scheduled are always complete (lib/jobs/officeList.ts); Verified and Cancelled show the latest
// jobs unless the office asks for all of one (?all=verified, ?all=cancelled).
import { officeGroup, type JobStatus } from '@/lib/jobs/status';
import { isHistoryGroup, type HistoryGroup } from '@/lib/jobs/officeList';
import { moneyGroup, type MoneyGroup } from './figures';

export const JOB_STAGES = ['to_schedule', 'needs_check', 'in_progress', 'scheduled', 'verified', 'cancelled'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

/** The stages whose jobs are all loaded, so their counts and totals are complete. */
export const OPEN_STAGES = ['to_schedule', 'needs_check', 'in_progress', 'scheduled'] as const satisfies readonly JobStage[];
export type OpenStage = (typeof OPEN_STAGES)[number];

/** The same words as the job badges. */
export const STAGE_LABELS: Record<JobStage, string> = {
  to_schedule: 'To schedule',
  needs_check: 'Needs check',
  in_progress: 'In progress',
  scheduled: 'Scheduled',
  verified: 'Verified',
  cancelled: 'Cancelled',
};

/** One plain line under each stage's heading: what the office does next. */
export const STAGE_HINTS: Record<JobStage, string> = {
  to_schedule: 'Signed. Give each a start date and a crew.',
  needs_check: 'The crew is done. Check their numbers, then verify.',
  in_progress: 'The crew has started.',
  scheduled: 'Has a start date.',
  verified: 'Done and checked. Their numbers feed Insights.',
  cancelled: 'Will not go ahead.',
};

export interface StageInput {
  status: JobStatus;
  scheduledStart: string | null;
  actualsCount: number;
  verifiedCount: number;
}

/** The stage of a job (agrees with jobBadgeStatus, which draws its badge). */
export function jobStage(job: StageInput): JobStage {
  switch (job.status) {
    case 'scheduled':
      return job.scheduledStart === null ? 'to_schedule' : 'scheduled';
    case 'in_progress':
      return 'in_progress';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return officeGroup(job) === 'verified' ? 'verified' : 'needs_check';
  }
}

/** The badge key for a stage. */
export const stageBadge = (s: JobStage) => `job.${s}` as const;

export function isJobStage(s: unknown): s is JobStage {
  return typeof s === 'string' && (JOB_STAGES as readonly string[]).includes(s);
}

/** The ?stage= filter: one stage, or null for every stage. */
export function parseStage(v: string | string[] | undefined): JobStage | null {
  const s = Array.isArray(v) ? v[0] : v;
  return isJobStage(s) ? s : null;
}

/** The history group a stage reads from, when it has one (verified, cancelled). */
export function historyGroupOf(stage: JobStage): HistoryGroup | null {
  return isHistoryGroup(stage) ? stage : null;
}

/** A /jobs link with these choices (empty ones left out), so the filter and "Show all" keep each other. */
export function jobsHref(f: { stage: JobStage | null; all: HistoryGroup | null }): string {
  const q = new URLSearchParams();
  if (f.stage) q.set('stage', f.stage);
  if (f.all) q.set('all', f.all);
  const s = q.toString();
  return s ? `/jobs?${s}` : '/jobs';
}

/** Rows (each with its stage) split by stage, keeping the order they came in. */
export function byStage<T extends { stage: JobStage }>(rows: readonly T[]): Record<JobStage, T[]> {
  const out = Object.fromEntries(JOB_STAGES.map((s) => [s, [] as T[]])) as Record<JobStage, T[]>;
  for (const r of rows) out[r.stage].push(r);
  return out;
}

/** Newest completion first (Needs check and Verified). */
export function sortByCompletion<T extends { completedAt: string | null }>(jobs: readonly T[]): T[] {
  return [...jobs].sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
}

/** The figures over the list: count and signed work for each open stage, from the listed jobs. */
export function jobKpis(rows: ReadonlyArray<{ stage: JobStage; price: number | null }>): Record<OpenStage, MoneyGroup> {
  const of = (s: OpenStage) => moneyGroup(rows.filter((r) => r.stage === s));
  return { to_schedule: of('to_schedule'), needs_check: of('needs_check'), in_progress: of('in_progress'), scheduled: of('scheduled') };
}

/** "3 of 4 rows checked", "No actuals yet": the actuals line for a finished job. */
export function actualsLine(job: { actualsCount: number; verifiedCount: number }): string {
  if (job.actualsCount === 0) return 'No actuals yet';
  if (job.verifiedCount >= job.actualsCount) return `All ${job.actualsCount} ${job.actualsCount === 1 ? 'row' : 'rows'} checked`;
  return `${job.verifiedCount} of ${job.actualsCount} ${job.actualsCount === 1 ? 'row' : 'rows'} checked`;
}

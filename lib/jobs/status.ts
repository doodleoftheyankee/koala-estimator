// Job status vocabulary, the transitions crew_set_job_status() allows, and how the crew and
// office screens group jobs. Pure.
import type { Role } from '@/lib/pricing';

export const JOB_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function isJobStatus(s: unknown): s is JobStatus {
  return typeof s === 'string' && (JOB_STATUSES as readonly string[]).includes(s);
}

/**
 * Moves the database accepts from `from` for this role (mirrors crew_set_job_status; the
 * database is the authority, this only decides which buttons to show).
 */
export function allowedTransitions(from: JobStatus, role: Role): JobStatus[] {
  const staff = role === 'owner' || role === 'office';
  const out: JobStatus[] = [];
  if (from === 'scheduled') out.push('in_progress');
  if (from === 'in_progress') out.push('completed', 'scheduled');
  if (from === 'completed' && staff) out.push('in_progress');
  if (staff && from !== 'cancelled') out.push('cancelled');
  return role === 'estimator' ? [] : out;
}

// ---------------------------------------------------------------------------
// Office grouping
// ---------------------------------------------------------------------------

export const OFFICE_GROUPS = ['in_progress', 'scheduled', 'awaiting_verification', 'verified', 'cancelled'] as const;
export type OfficeGroup = (typeof OFFICE_GROUPS)[number];

export const OFFICE_GROUP_LABELS: Record<OfficeGroup, string> = {
  in_progress: 'In progress',
  scheduled: 'Scheduled',
  awaiting_verification: 'Completed: awaiting verification',
  verified: 'Verified',
  cancelled: 'Cancelled',
};

/** A completed job is verified only when it has actuals and every row is verified. */
export function officeGroup(job: { status: JobStatus; actualsCount: number; verifiedCount: number }): OfficeGroup {
  if (job.status !== 'completed') return job.status;
  return job.actualsCount > 0 && job.verifiedCount >= job.actualsCount ? 'verified' : 'awaiting_verification';
}

export function groupForOffice<T extends { status: JobStatus; actualsCount: number; verifiedCount: number }>(
  jobs: readonly T[],
): Record<OfficeGroup, T[]> {
  const out: Record<OfficeGroup, T[]> = { in_progress: [], scheduled: [], awaiting_verification: [], verified: [], cancelled: [] };
  for (const j of jobs) out[officeGroup(j)].push(j);
  return out;
}

// ---------------------------------------------------------------------------
// Crew grouping
// ---------------------------------------------------------------------------

export const CREW_SECTIONS = ['in_progress', 'upcoming', 'recent'] as const;
export type CrewSection = (typeof CREW_SECTIONS)[number];

export const CREW_SECTION_LABELS: Record<CrewSection, string> = {
  in_progress: 'In progress',
  upcoming: 'Today & upcoming',
  recent: 'Recently completed',
};

interface CrewSortable {
  status: JobStatus;
  scheduledStart: string | null; // YYYY-MM-DD
  startedAt: string | null; // ISO
  completedAt: string | null; // ISO
}

/**
 * In progress (oldest start first), then scheduled jobs by date (unscheduled last; a past date
 * that never started stays here, at the top), then completed ones (newest first). Cancelled
 * jobs are not shown to crews.
 */
export function groupForCrew<T extends CrewSortable>(jobs: readonly T[]): Record<CrewSection, T[]> {
  const out: Record<CrewSection, T[]> = { in_progress: [], upcoming: [], recent: [] };
  for (const j of jobs) {
    if (j.status === 'in_progress') out.in_progress.push(j);
    else if (j.status === 'scheduled') out.upcoming.push(j);
    else if (j.status === 'completed') out.recent.push(j);
  }
  const cmp = (a: string | null, b: string | null, nullsLast: boolean) =>
    a === b ? 0 : a === null ? (nullsLast ? 1 : -1) : b === null ? (nullsLast ? -1 : 1) : a < b ? -1 : 1;
  out.in_progress.sort((a, b) => cmp(a.startedAt, b.startedAt, true));
  out.upcoming.sort((a, b) => cmp(a.scheduledStart, b.scheduledStart, true));
  out.recent.sort((a, b) => -cmp(a.completedAt, b.completedAt, false));
  return out;
}

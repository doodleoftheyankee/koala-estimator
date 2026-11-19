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
 * The status buttons to show: the moves the database accepts from `from` for this role (mirrors
 * crew_set_job_status; the database is the authority). A job with verified actuals offers none
 * (L37): verified rows are locked and feed learning, so the job stays completed until the owner
 * unverifies them.
 */
export function allowedTransitions(from: JobStatus, role: Role, verifiedCount = 0): JobStatus[] {
  if (verifiedCount > 0) return [];
  const staff = role === 'owner' || role === 'office';
  const out: JobStatus[] = [];
  if (from === 'scheduled') out.push('in_progress');
  if (from === 'in_progress') out.push('completed', 'scheduled');
  if (from === 'completed' && staff) out.push('in_progress');
  if (staff && from !== 'cancelled') out.push('cancelled');
  return role === 'estimator' ? [] : out;
}

/** What the Status card says on a job with verified actuals, by who is looking (only the owner can Unverify). */
export const VERIFIED_STATUS_TEXT: Record<'owner' | 'office', string> = {
  owner: 'Its actuals are verified, so the status stays as it is. To change it, Unverify the actuals below first.',
  office: 'Its actuals are verified, so the status stays as it is. Only the owner can Unverify them.',
};

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

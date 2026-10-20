'use client';
import Link from 'next/link';
import { crewDb, type ActualsSyncState, type LocalActuals, type LocalJob } from '@/lib/offline/crewDb';
import type { CachedProfile } from '@/lib/offline/db';
import { dayLabel, nyDate } from '@/lib/jobs/dates';
import { CREW_SECTION_LABELS, CREW_SECTIONS, groupForCrew } from '@/lib/jobs/status';
import type { CrewJob } from '@/lib/jobs/crew';
import { Badge, Button } from '@/components/ui';
import { useLive } from '@/app/field/hooks';

export const ACTUALS_BADGE: Record<ActualsSyncState, { tone: 'slate' | 'green' | 'amber' | 'red' | 'blue'; label: string }> = {
  pending: { tone: 'amber', label: 'Not synced' },
  synced: { tone: 'green', label: 'Synced' },
  locked: { tone: 'blue', label: 'Verified' },
  invalid: { tone: 'red', label: 'Needs fixing' },
  error: { tone: 'amber', label: 'Retrying' },
};

const UNSYNCED: ReadonlySet<ActualsSyncState> = new Set(['pending', 'error', 'invalid']);

export function JobList({
  profile,
  online,
  syncing,
  onOpen,
  onSync,
}: {
  profile: CachedProfile;
  online: boolean;
  syncing: boolean;
  onOpen: (id: string) => void;
  onSync: () => void;
}) {
  const jobs = useLive(() => crewDb().jobs.where('ownerId').equals(profile.userId).toArray(), [profile.userId], [] as LocalJob[]);
  const drafts = useLive(() => crewDb().actuals.toArray(), [], [] as LocalActuals[]);
  const draftByJob = new Map(drafts.map((d) => [d.jobId, d]));
  const unsynced = drafts.filter((d) => d.ownerId === profile.userId && UNSYNCED.has(d.syncState)).length;
  const groups = groupForCrew(jobs.map((j) => ({ ...j.job, id: j.id })));
  const today = nyDate(new Date());

  return (
    <div className="pb-10">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold">Jobs</h1>
            <p className="text-xs text-slate-500">
              {profile.fullName} ·{' '}
              <span className={online ? 'text-emerald-700' : 'text-amber-700'}>{online ? 'Online' : 'Offline, saving on this phone'}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {profile.role !== 'crew' ? (
              <Link href="/jobs" prefetch={false} className="rounded-lg px-3 py-2 text-sm font-medium text-brand-800 hover:bg-brand-50">
                Office
              </Link>
            ) : null}
            <Button size="sm" variant="secondary" onClick={onSync} disabled={!online || syncing} aria-busy={syncing}>
              {syncing ? 'Syncing…' : `Sync${unsynced ? ` (${unsynced})` : ''}`}
            </Button>
          </div>
        </div>
      </header>

      {jobs.length === 0 ? (
        <p className="m-3 rounded-2xl bg-white p-6 text-center text-slate-500 ring-1 ring-slate-200">
          {online ? 'No jobs assigned to your crew right now.' : 'No jobs on this phone yet. Open this screen once with signal.'}
        </p>
      ) : null}

      {CREW_SECTIONS.map((section) =>
        groups[section].length ? (
          <section key={section} className="px-3 pt-4" aria-labelledby={`sec-${section}`}>
            <h2 id={`sec-${section}`} className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
              {CREW_SECTION_LABELS[section]}
            </h2>
            <ul className="space-y-2">
              {groups[section].map((job) => (
                <li key={job.id}>
                  <JobCard job={job} draft={draftByJob.get(job.id)} today={today} onOpen={() => onOpen(job.id)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

/** "today" / "yesterday" read better mid-sentence; dates stay as they are. */
const relative = (label: string) => (/^(Today|Tomorrow|Yesterday)$/.test(label) ? label.toLowerCase() : label);

function JobCard({ job, draft, today, onOpen }: { job: CrewJob; draft: LocalActuals | undefined; today: string; onOpen: () => void }) {
  const hazards = job.areas.some((a) => a.hazards.length > 0);
  const when =
    job.status === 'completed' && job.completedAt
      ? `Completed ${relative(dayLabel(nyDate(job.completedAt), today))}`
      : job.scheduledStart
        ? `${dayLabel(job.scheduledStart, today)}${job.scheduledDays ? ` · ${job.scheduledDays} day${job.scheduledDays === 1 ? '' : 's'}` : ''}`
        : 'Not scheduled yet';
  const overdue = job.status === 'scheduled' && job.scheduledStart !== null && job.scheduledStart < today;
  const badge = draft && draft.syncState !== 'synced' ? ACTUALS_BADGE[draft.syncState] : null;
  return (
    <button type="button" onClick={onOpen} className="block w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={overdue ? 'font-semibold text-amber-800' : 'font-semibold text-slate-900'}>
            {when}
            {overdue ? ' · not started' : ''}
          </p>
          <p className="truncate text-slate-800">{job.customer.name}</p>
          <p className="truncate text-sm text-slate-600">
            {job.address.street}, {job.address.city}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {hazards ? <Badge tone="red">Hazards</Badge> : null}
          {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">{job.areas.map((a) => a.name).join(' · ') || 'No areas'}</p>
    </button>
  );
}

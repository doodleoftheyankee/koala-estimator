'use client';
import { crewDb, type ActualsSyncState, type LocalActuals, type LocalJob } from '@/lib/offline/crewDb';
import type { CachedProfile } from '@/lib/offline/db';
import { dayLabel, nyDate } from '@/lib/jobs/dates';
import { CREW_SECTION_LABELS, CREW_SECTIONS, groupForCrew } from '@/lib/jobs/status';
import type { CrewJob } from '@/lib/jobs/crew';
import {
  Banner,
  CloudCheck,
  CloudOff,
  CloudUpload,
  EmptyState,
  Hammer,
  Monogram,
  RefreshCw,
  SectionHead,
  ShieldCheck,
  SyncIndicator,
  SyncNowButton,
  Tag,
  TriangleAlert,
  type LucideIcon,
  type TagTone,
} from '@/components/daymark';
import { num, plural } from '@/lib/format';
import { useLive } from '@/app/field/hooks';

/** The crew's actuals, as a status tag: icon + word + colour, like every status in the app. */
export const ACTUALS_BADGE: Record<ActualsSyncState, { tone: TagTone; icon: LucideIcon; label: string }> = {
  pending: { tone: 'warn', icon: CloudUpload, label: 'Not synced' },
  synced: { tone: 'ok', icon: CloudCheck, label: 'Synced' },
  // Verified is green everywhere, with the same shield as the office's job page (StatusBadge).
  locked: { tone: 'ok', icon: ShieldCheck, label: 'Verified' },
  invalid: { tone: 'bad', icon: TriangleAlert, label: 'Needs fixing' },
  error: { tone: 'warn', icon: RefreshCw, label: 'Retrying' },
};

/** A crew actuals tag. */
export function ActualsTag({ state }: { state: ActualsSyncState }) {
  const b = ACTUALS_BADGE[state];
  return (
    <Tag tone={b.tone} icon={b.icon}>
      {b.label}
    </Tag>
  );
}

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
      {/* The same header as the field list: the mark, the page name, the phone's one sync state. */}
      <header className="flex items-start gap-3 px-4 pt-4 lg:pt-8">
        <Monogram size={48} label="" className="mt-0.5 lg:hidden" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[30px] leading-[1.07] font-extrabold tracking-[-0.02em] text-ink">{profile.role === 'crew' ? 'Jobs' : 'Crew app'}</h1>
          <SyncIndicator
            state={syncing ? 'syncing' : !online ? 'offline' : unsynced ? 'pending' : 'synced'}
            pending={unsynced}
            className="mt-0.5"
          />
        </div>
        <SyncNowButton online={online} syncing={syncing} onSync={onSync} />
      </header>

      {!online ? (
        <div className="px-4 pt-4">
          <Banner tone="hazard" icon={CloudOff} title="Offline." live={false}>
            Saving on this phone.{unsynced ? ` ${plural(unsynced, 'job')} will sync when you have signal.` : ''}
          </Banner>
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <EmptyState
          className="px-4"
          icon={Hammer}
          title={online ? 'No jobs for your crew right now' : 'No jobs on this phone yet'}
          hint={online ? 'Ask the office to add you to a crew, or to give your crew a job.' : 'Open this screen once with signal to load your jobs.'}
        />
      ) : null}

      {CREW_SECTIONS.map((section) =>
        groups[section].length ? (
          <section key={section} className="space-y-2.5 px-3 pt-4" aria-labelledby={`sec-${section}`}>
            <SectionHead id={`sec-${section}`} count={num(groups[section].length)} className="px-1">
              {CREW_SECTION_LABELS[section]}
            </SectionHead>
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
  const badge = draft && draft.syncState !== 'synced' ? draft.syncState : null;
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
          {hazards ? (
            <Tag tone="bad" icon={TriangleAlert}>
              Hazards
            </Tag>
          ) : null}
          {badge ? <ActualsTag state={badge} /> : null}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">{job.areas.map((a) => a.name).join(' · ') || 'No areas'}</p>
    </button>
  );
}

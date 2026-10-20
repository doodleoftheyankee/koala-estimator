import type { Metadata } from 'next';
import Link from 'next/link';
import { AppNav } from '@/components/AppNav';
import { Alert, Badge, Card } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { formatNyDateTime, formatYmd, nyDate } from '@/lib/jobs/dates';
import { signedOption } from '@/lib/jobs/office';
import { groupForOffice, OFFICE_GROUP_LABELS, OFFICE_GROUPS, type OfficeGroup } from '@/lib/jobs/status';
import { loadJobList, type JobListItem } from './data';

export const metadata: Metadata = { title: 'Jobs' };

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

const GROUP_TONE: Record<OfficeGroup, 'slate' | 'green' | 'amber' | 'red' | 'blue'> = {
  in_progress: 'amber',
  scheduled: 'blue',
  awaiting_verification: 'red',
  verified: 'green',
  cancelled: 'slate',
};

export default async function JobsPage() {
  const profile = await requireRole('owner', 'office');
  const db = await createClient();
  const { jobs, error } = await loadJobList(db);
  const groups = groupForOffice(jobs);
  const today = nyDate(new Date());

  return (
    <>
      <AppNav profile={profile} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-slate-900">Jobs</h1>
          <Link href="/crew" className="inline-flex min-h-12 items-center rounded-xl px-3 font-semibold text-brand-800 hover:bg-brand-50">
            Open the crew app
          </Link>
        </div>
        <p className="text-sm text-slate-600">
          Jobs are created when a customer signs a quote. Assign a crew and a date, then verify the crew&apos;s actuals once the job is done. Only verified
          actuals feed the nightly learning run.
        </p>

        {error ? <Alert tone="red">Could not load jobs: {error}</Alert> : null}
        {!error && jobs.length === 0 ? (
          <Card>
            <p className="text-slate-600">No jobs yet. A job appears here as soon as a customer signs a quote.</p>
          </Card>
        ) : null}

        {OFFICE_GROUPS.map((g) =>
          groups[g].length ? (
            <section key={g} className="space-y-3" aria-labelledby={`grp-${g}`}>
              <h2 id={`grp-${g}`} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                {OFFICE_GROUP_LABELS[g]} <Badge tone={GROUP_TONE[g]}>{groups[g].length}</Badge>
              </h2>
              <ul className="grid gap-3 md:grid-cols-2">
                {(g === 'verified' || g === 'awaiting_verification' ? sortByCompletion(groups[g]) : groups[g]).map((j) => (
                  <li key={j.id}>
                    <JobCard job={j} group={g} today={today} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null,
        )}
      </main>
    </>
  );
}

const sortByCompletion = (jobs: JobListItem[]) => [...jobs].sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

function JobCard({ job, group, today }: { job: JobListItem; group: OfficeGroup; today: string }) {
  const option = signedOption({ document: { options: job.docOptions } }, job.signedTier, job.signedPrice);
  const when = job.scheduledStart
    ? `${formatYmd(job.scheduledStart, today)}${job.scheduledDays ? ` · ${job.scheduledDays} day${job.scheduledDays === 1 ? '' : 's'}` : ''}`
    : 'Not scheduled';
  return (
    <Link href={`/jobs/${job.id}`} className="block h-full rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{job.customer}</p>
          <p className="truncate text-sm text-slate-600">{job.address}</p>
        </div>
        {option?.price != null ? <span className="shrink-0 text-lg font-bold tabular-nums text-slate-900">{usd.format(option.price)}</span> : null}
      </div>
      <p className="mt-2 text-sm text-slate-700">{option ? option.label : 'Signed option unknown'}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
        <span>{when}</span>
        <span>{job.crew ?? <span className="font-medium text-amber-700">No crew assigned</span>}</span>
        {group === 'awaiting_verification' || group === 'verified' ? (
          <span>
            {job.actualsCount ? `${job.verifiedCount}/${job.actualsCount} rows verified` : 'No actuals yet'}
            {job.completedAt ? ` · done ${formatNyDateTime(job.completedAt)}` : ''}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

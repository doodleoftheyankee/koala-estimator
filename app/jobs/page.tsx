import type { Metadata } from 'next';
import Link from 'next/link';
import { Banner, ButtonLink, EmptyState, Hammer, SectionHead, Smartphone, StatusBadge } from '@/components/daymark';
import { PageHeader } from '@/components/shell';
import { FilterChips, KpiStrip, ROW_LINK, TABLE, type KpiItem } from '@/components/office';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { formatDateTime, formatMoney, formatShortDateTime, num, plural } from '@/lib/format';
import { dayLabel, nyDate } from '@/lib/jobs/dates';
import { signedOption } from '@/lib/jobs/office';
import { parseShowAll, type HistoryGroup } from '@/lib/jobs/officeList';
import {
  actualsLine,
  byStage,
  historyGroupOf,
  JOB_STAGES,
  jobKpis,
  jobsHref,
  jobStage,
  OPEN_STAGES,
  parseStage,
  sortByCompletion,
  stageBadge,
  STAGE_HINTS,
  STAGE_LABELS,
  type JobStage,
  type OpenStage,
} from '@/lib/office/jobs';
import type { MoneyGroup } from '@/lib/office/figures';
import { loadJobList, type JobListItem } from './data';

export const metadata: Metadata = { title: 'Jobs' };

interface Row {
  id: string;
  stage: JobStage;
  customer: string;
  address: string;
  /** The signed option's name. */
  work: string;
  price: number | null;
  /** "Tomorrow · 2.5 days", or null with no start date. */
  when: string | null;
  crew: string | null;
  /** For finished jobs: how many actuals rows are checked, and when the crew finished. */
  actuals: string | null;
  completedAt: string | null;
}

function toRow(j: JobListItem, today: string): Row {
  const option = signedOption({ document: { options: j.docOptions } }, j.signedTier, j.signedPrice);
  const stage = jobStage(j);
  const finished = stage === 'needs_check' || stage === 'verified';
  return {
    id: j.id,
    stage,
    customer: j.customer,
    address: j.address,
    work: option ? option.label : 'Signed option unknown',
    price: option?.price ?? null,
    when: j.scheduledStart
      ? `${dayLabel(j.scheduledStart, today)}${j.scheduledDays ? ` · ${num(j.scheduledDays, 1)} ${j.scheduledDays === 1 ? 'day' : 'days'}` : ''}`
      : null,
    crew: j.crew,
    actuals: finished ? actualsLine(j) : null,
    completedAt: j.completedAt,
  };
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ all?: string | string[]; stage?: string | string[] }> }) {
  await requireRole('owner', 'office');
  const db = await createClient();
  const sp = await searchParams;
  const showAll = parseShowAll(sp.all);
  const stage = parseStage(sp.stage);
  const { jobs, partial, error } = await loadJobList(db, showAll);
  const today = nyDate(new Date());
  const rows = jobs.map((j) => toRow(j, today));
  const groups = byStage(rows);
  groups.needs_check = sortByCompletion(groups.needs_check);
  groups.verified = sortByCompletion(groups.verified);
  const kpis = jobKpis(rows);
  const shown = (stage ? [stage] : JOB_STAGES).filter((s) => groups[s].length > 0);
  const openCount = OPEN_STAGES.reduce((n, s) => n + kpis[s].count, 0);

  return (
    <main className="@container mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Jobs"
        description="A job starts when a customer signs. Give it a start date and a crew, then check the crew’s numbers when they finish."
        actions={
          <ButtonLink href="/crew" variant="ghost" size="sm" icon={Smartphone} prefetch={false}>
            Open the crew app
          </ButtonLink>
        }
      />

      {!error && jobs.length > 0 ? (
        <KpiStrip
          title="Figures for open jobs"
          items={OPEN_STAGES.map((s) => kpiItem(s, kpis[s]))}
          note={`These figures count every open job${stage && !(OPEN_STAGES as readonly string[]).includes(stage) ? ', not only the ones shown' : ''}: ${plural(openCount, 'job')} not yet verified or cancelled. Signed work is the total of their signed prices.`}
        />
      ) : null}

      <FilterChips
        label="Show"
        items={[
          { key: 'all', label: 'All jobs', current: stage === null, href: jobsHref({ stage: null, all: showAll }) },
          ...JOB_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s], current: stage === s, href: jobsHref({ stage: s, all: showAll }) })),
        ]}
      />

      {error ? (
        <Banner
          tone="bad"
          title="Could not load every job"
          action={
            <ButtonLink href={jobsHref({ stage, all: showAll })} size="sm" prefetch={false}>
              Try again
            </ButtonLink>
          }
        >
          {error}
        </Banner>
      ) : null}

      {!error && jobs.length === 0 ? (
        <EmptyState icon={Hammer} title="No jobs yet" hint="A job appears here as soon as a customer signs a quote." />
      ) : null}
      {!error && jobs.length > 0 && shown.length === 0 && stage ? (
        <EmptyState
          icon={Hammer}
          title={`No jobs in ${STAGE_LABELS[stage]} right now`}
          hint={STAGE_HINTS[stage]}
          action={
            <ButtonLink href={jobsHref({ stage: null, all: showAll })} prefetch={false}>
              Show every job
            </ButtonLink>
          }
        />
      ) : null}

      {shown.map((s) => (
        <StageSection key={s} stage={s} rows={groups[s]} partial={historyPartial(s, partial)} filterStage={stage} />
      ))}
    </main>
  );
}

function historyPartial(s: JobStage, partial: Partial<Record<HistoryGroup, { shown: number; total: number }>>) {
  const g = historyGroupOf(s);
  return g ? (partial[g] ?? null) : null;
}

const KPI_DETAIL: Record<OpenStage, (n: number) => string> = {
  to_schedule: (n) => `${n === 1 ? 'job has' : 'jobs have'} no start date`,
  needs_check: (n) => `${n === 1 ? 'job is' : 'jobs are'} done, actuals to check`,
  in_progress: (n) => `${n === 1 ? 'job has' : 'jobs have'} a crew on site`,
  scheduled: (n) => `${n === 1 ? 'job has' : 'jobs have'} a start date`,
};

function kpiItem(s: OpenStage, g: MoneyGroup): KpiItem {
  const work = g.total !== null ? `${formatMoney(g.total)} signed work` : null;
  const missing = g.unpriced ? `${g.unpriced} without a price not in the total` : null;
  return {
    key: s,
    label: STAGE_LABELS[s],
    value: String(g.count),
    detail: [KPI_DETAIL[s](g.count), work, missing].filter(Boolean).join(' · '),
  };
}

function StageSection({
  stage,
  rows,
  partial,
  filterStage,
}: {
  stage: JobStage;
  rows: Row[];
  partial: { shown: number; total: number } | null;
  filterStage: JobStage | null;
}) {
  const id = `stage-${stage}`;
  const g = historyGroupOf(stage);
  return (
    <section className="space-y-3" aria-labelledby={id}>
      <SectionHead id={id} count={partial ? partial.total : rows.length}>
        {STAGE_LABELS[stage]}
      </SectionHead>
      <p className="text-[15px] font-medium text-ink-2">
        {STAGE_HINTS[stage]}
        {partial && g ? (
          <>
            {' '}
            Showing the latest {partial.shown} of {partial.total}.{' '}
            <Link href={jobsHref({ stage: filterStage, all: g })} prefetch={false} className="font-bold text-ink underline underline-offset-4">
              Show all {partial.total}
            </Link>
          </>
        ) : null}
      </p>

      {/* Narrow screens: one plate, a block per job. */}
      <ul aria-label={STAGE_LABELS[stage]} className="plate divide-y divide-solid divide-line @4xl:hidden">
        {rows.map((r) => (
          <li key={r.id} className="relative space-y-1.5 px-4 py-3.5 hover:bg-sunken">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/jobs/${r.id}`} prefetch={false} className={`${ROW_LINK} text-[18px]`}>
                  {r.customer}
                </Link>
                <p className="mt-0.5 text-[15px] font-medium text-ink-2">{r.address}</p>
              </div>
              <StatusBadge status={stageBadge(r.stage)} />
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0 space-y-0.5 text-[15px] font-medium text-ink-2">
                <p className="font-bold text-ink">{r.work}</p>
                <Schedule row={r} inline />
                {r.actuals ? <Finished row={r} /> : null}
              </div>
              <Price price={r.price} />
            </div>
          </li>
        ))}
      </ul>

      {/* Wide screens: a hairline table. */}
      <div className={`${TABLE.plate} hidden @4xl:block`}>
        <table className={`${TABLE.table} table-fixed`}>
          <caption className="sr-only">{STAGE_LABELS[stage]}</caption>
          {/* The same widths in every section, so the columns line up down the page. */}
          <colgroup>
            <col />
            <col />
            <col className="w-44" />
            <col className="w-56" />
            <col className="w-32" />
          </colgroup>
          <thead>
            <tr className={TABLE.headRow}>
              <th scope="col" className={TABLE.th}>
                Customer
              </th>
              <th scope="col" className={TABLE.th}>
                Work
              </th>
              <th scope="col" className={TABLE.th}>
                Start and crew
              </th>
              <th scope="col" className={TABLE.th}>
                Status
              </th>
              <th scope="col" className={`${TABLE.th} ${TABLE.thNum}`}>
                Price
              </th>
            </tr>
          </thead>
          <tbody className={TABLE.body}>
            {rows.map((r) => (
              <tr key={r.id} className={TABLE.row}>
                <td className={TABLE.td}>
                  <Link href={`/jobs/${r.id}`} prefetch={false} className={ROW_LINK}>
                    {r.customer}
                  </Link>
                  <p className="mt-0.5 text-[15px] font-medium text-ink-2">{r.address}</p>
                </td>
                <td className={`${TABLE.td} font-semibold text-ink`}>{r.work}</td>
                <td className={`${TABLE.td} text-[15px] font-medium text-ink-2`}>
                  <Schedule row={r} />
                </td>
                <td className={TABLE.td}>
                  <StatusBadge status={stageBadge(r.stage)} />
                  {r.actuals ? (
                    <div className="mt-1.5 text-[15px] leading-snug font-medium text-ink-2">
                      <Finished row={r} />
                    </div>
                  ) : null}
                </td>
                <td className={`${TABLE.td} ${TABLE.tdNum}`}>
                  <Price price={r.price} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Start date and crew; a missing one is said in words (and in the warn colour, never colour alone). */
function Schedule({ row: r, inline = false }: { row: Row; inline?: boolean }) {
  const when = r.when ?? <span className="font-bold text-warn">No start date</span>;
  const crew = r.crew ?? <span className="font-bold text-warn">No crew yet</span>;
  if (r.stage === 'cancelled') return <p>{r.when ?? 'Never scheduled'}</p>;
  if (inline) {
    return (
      <p>
        {when} · {crew}
      </p>
    );
  }
  return (
    <>
      <p className="text-ink">{when}</p>
      <p>{crew}</p>
    </>
  );
}

function Finished({ row: r }: { row: Row }) {
  return (
    <p>
      {r.actuals}
      {r.completedAt ? (
        <>
          {' · done '}
          <time dateTime={r.completedAt} title={formatDateTime(r.completedAt)}>
            {formatShortDateTime(r.completedAt)}
          </time>
        </>
      ) : null}
    </p>
  );
}

function Price({ price }: { price: number | null }) {
  if (price === null) return <span className="text-[15px] font-semibold text-ink-3">No price</span>;
  return (
    <span className="gauge-m text-[22px] whitespace-nowrap text-ink">
      <span className="sr-only">Signed price </span>
      {formatMoney(price)}
    </span>
  );
}

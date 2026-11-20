'use client';
// The crew app's Load list: what to put on the truck at the shop for the jobs that start today or
// tomorrow, built on the phone from its own copy of the crew's jobs (lib/jobs/loadList.ts), so it
// opens with no signal. Each material is the estimate's quantity summed over areas and jobs and
// rounded up to a whole unit (owner decision: exactly what the estimate calculated, no extra). Then
// the owner's always-bring list and a blower door kit for each job whose test-out is still to do,
// each a box to tick while loading (ticks stay on this phone, per day; a material's tick holds the
// amount it was ticked at, so it shows unticked, with what changed, once the day's amount differs).
// Then each job's short header with the estimator's and the office's notes. Never a price.
import { useEffect, useState, type ReactNode } from 'react';
import { ALWAYS_BRING_KEY, crewDb, type CachedAlwaysBring, type LocalJob } from '@/lib/offline/crewDb';
import { blowerDoorDb, type LocalContext } from '@/lib/offline/blowerDoor';
import { contextKey, mergeReadings, type LocalTest } from '@/lib/offline/blowerDoorCore';
import { refreshBlowerDoorReadings, toggleLoaded } from '@/lib/offline/crewLoad';
import {
  alwaysBringLines,
  blowerDoorKitLine,
  changedText,
  dayLoadList,
  dayText,
  isTicked,
  loadDates,
  loadProgress,
  needsBlowerDoorKit,
  PLUS_UNKNOWN,
  qtyText,
  tickedBefore,
  ticksKey,
  type DayLoad,
  type EquipmentLine,
  type LoadJob,
  type LoadLine,
  type Ticks,
} from '@/lib/jobs/loadList';
import { formatYmd } from '@/lib/jobs/dates';
import { plural } from '@/lib/format';
import { Check, ChevronRight, cx, Icon, SignLabel, Tabs, Truck } from '@/components/daymark';
import { useLive } from '@/app/field/hooks';
import { CrewNotesBlock } from './CrewNotes';

type Day = 'today' | 'tomorrow';

export function LoadList({ ownerId, jobs, today, online, onOpen }: { ownerId: string; jobs: readonly LocalJob[]; today: string; online: boolean; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<Day>('today');
  const dates = loadDates(today);
  const date = dates[tab];
  const crewJobs = jobs.map((j) => j.job);
  const lists = { today: dayLoadList(crewJobs, dates.today), tomorrow: dayLoadList(crewJobs, dates.tomorrow) };
  const day = lists[tab];

  const always = useLive<CachedAlwaysBring | undefined>(
    () => crewDb().meta.get(ALWAYS_BRING_KEY).then((r) => r?.value as CachedAlwaysBring | undefined),
    [],
    undefined,
  );
  const key = ticksKey(ownerId, date);
  const stored = useLive<{ key: string; ticks: Ticks }>(
    () => crewDb().meta.get(key).then((r) => ({ key, ticks: (r?.value as Ticks | undefined) ?? {} })),
    [key],
    { key, ticks: {} },
  );
  // Switching days shows that day's ticks only, never the other day's for a moment.
  const ticks = stored.key === key ? stored.ticks : {};

  // The blower door readings of the jobs on either day: the server's copy (loaded while there is
  // signal, through the existing price-free readings endpoint) and the phone's own unsent ones.
  const windowIds = [...lists.today.jobs, ...lists.tomorrow.jobs].map((j) => j.jobId);
  const idsKey = windowIds.join(',');
  useEffect(() => {
    if (online && idsKey) void refreshBlowerDoorReadings(idsKey.split(','), ownerId);
  }, [online, idsKey, ownerId]);
  const contexts = useLive<LocalContext[]>(() => blowerDoorDb().contexts.where('ownerId').equals(ownerId).toArray(), [ownerId], []);
  const localTests = useLive<LocalTest[]>(() => blowerDoorDb().tests.where('ownerId').equals(ownerId).toArray(), [ownerId], []);
  const kitLines = day.jobs
    .filter((j) => {
      const ck = contextKey({ kind: 'job', id: j.jobId, label: null });
      const saved = contexts.find((c) => c.contextKey === ck)?.tests ?? [];
      return needsBlowerDoorKit(mergeReadings(saved, localTests.filter((t) => t.contextKey === ck)).map((r) => r.test));
    })
    .map(blowerDoorKitLine);
  const equipment: EquipmentLine[] = day.jobs.length ? [...kitLines, ...alwaysBringLines(always?.items ?? [])] : [];

  const { done, total } = loadProgress(day.lines, equipment, ticks);
  const toggle = (line: LoadLine | EquipmentLine) => {
    toggleLoaded(ownerId, date, line, today).catch((e) => console.error('[load list] could not keep the tick on this phone', e));
  };

  return (
    <section aria-labelledby="load-list-title" className="plate p-4" data-testid="load-list">
      <div className="flex items-center gap-3">
        <Icon icon={Truck} size="l" className="text-ink" />
        <h2 id="load-list-title" className="min-w-0 flex-1 text-[22px] leading-tight font-extrabold text-ink">
          Load list
        </h2>
        {total ? (
          <span className="shrink-0 text-[15px] font-bold text-ink-2" aria-live="polite" data-testid="load-progress">
            {done} of {total} loaded
          </span>
        ) : null}
      </div>
      <Tabs
        label="Load list for"
        value={tab}
        onChange={setTab}
        className="mt-3"
        items={[
          { value: 'today', label: 'Today', panelId: 'load-list-panel' },
          { value: 'tomorrow', label: 'Tomorrow', panelId: 'load-list-panel' },
        ]}
      />
      <div id="load-list-panel" role="tabpanel" aria-label={tab === 'today' ? 'Today' : 'Tomorrow'} className="mt-3">
        <p className="text-[16px] font-semibold text-ink-2">
          {formatYmd(date, today)} · {day.jobs.length ? `${plural(day.jobs.length, 'job')} ${day.jobs.length === 1 ? 'starts' : 'start'}` : `no job starts ${tab}`}
        </p>
        <DayBody day={day} equipment={equipment} ticks={ticks} onToggle={toggle} onOpen={onOpen} when={tab} />
      </div>
    </section>
  );
}

export function DayBody({
  day,
  equipment,
  ticks,
  onToggle,
  onOpen,
  when,
}: {
  day: DayLoad;
  equipment: EquipmentLine[];
  ticks: Ticks;
  onToggle: (line: LoadLine | EquipmentLine) => void;
  onOpen: (id: string) => void;
  when: Day;
}) {
  return (
    <>
      {day.jobs.length === 0 ? <p className="mt-2 text-[16px] font-medium text-ink-2">Nothing to load for {when}.</p> : null}

      {day.lines.length ? (
        <Group title="Materials" hint="What the estimate calculated, added up and rounded up to whole units.">
          {day.lines.map((l) => (
            <MaterialRow key={l.key} line={l} jobs={day.jobs.length} ticks={ticks} onToggle={() => onToggle(l)} />
          ))}
        </Group>
      ) : day.jobs.length ? (
        <p className="mt-3 text-[16px] font-medium text-ink-2">No materials in the signed scope.</p>
      ) : null}

      {equipment.length ? (
        <Group title="Always bring">
          {equipment.map((e) => (
            <CheckRow key={e.key} checked={isTicked(ticks, e)} onToggle={() => onToggle(e)}>
              <span className="block text-[17px] leading-snug font-bold text-ink">{e.text}</span>
            </CheckRow>
          ))}
        </Group>
      ) : null}

      {day.jobs.length ? (
        <div className="mt-4">
          <SignLabel as="h3">{day.jobs.length === 1 ? 'The job' : 'The jobs'}</SignLabel>
          <ul className="mt-2 space-y-3">
            {day.jobs.map((j) => (
              <JobHeader key={j.jobId} job={j} onOpen={() => onOpen(j.jobId)} />
            ))}
          </ul>
        </div>
      ) : null}

      {day.continuing.length ? (
        <div className="mt-4">
          <SignLabel as="h3">Still on site</SignLabel>
          <ul className="mt-2 space-y-1">
            {day.continuing.map((j) => (
              <li key={j.jobId} className="text-[16px] font-medium text-ink-2">
                {j.customer}, {j.street} · {dayText(j)}: loaded on day 1.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <SignLabel as="h3">{title}</SignLabel>
      {hint ? <p className="mt-1 text-[15px] leading-snug font-medium text-ink-2">{hint}</p> : null}
      <ul className="mt-2 divide-y divide-line overflow-hidden rounded-control border-[length:var(--bw)] border-solid border-edge">{children}</ul>
    </div>
  );
}

/** A line to tick off: a 56 px row, the whole row is the target (gloves). */
function CheckRow({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        className={cx(
          'flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-[var(--t-quick)] focus-visible:-outline-offset-[5px]',
          checked ? 'bg-hivis-wash' : 'bg-surface hover:bg-sunken',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border-[length:var(--bw)] border-solid',
            checked ? 'border-hivis-edge bg-hivis text-on-hivis' : 'border-edge bg-surface',
          )}
        >
          {checked ? <Icon icon={Check} size="s" /> : null}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-3">{children}</span>
      </button>
    </li>
  );
}

/**
 * A material to tick off. Ticked at another amount than it says now (a job moved onto or off the
 * day after the tick), it shows unticked with what changed, so the truck is checked again.
 */
function MaterialRow({ line, jobs, ticks, onToggle }: { line: LoadLine; jobs: number; ticks: Ticks; onToggle: () => void }) {
  const was = tickedBefore(ticks, line);
  return (
    <CheckRow checked={isTicked(ticks, line)} onToggle={onToggle}>
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] leading-snug font-bold text-ink [overflow-wrap:anywhere]">{line.name}</span>
        {jobs > 1 ? <span className="block text-[15px] font-medium text-ink-2">{line.jobIds.length === jobs ? 'All the jobs' : `For ${plural(line.jobIds.length, 'job')}`}</span> : null}
        {line.plusUnknown ? <span className="block text-[15px] leading-snug font-semibold text-ink-2">{PLUS_UNKNOWN}</span> : null}
        {was ? (
          <span className="mt-0.5 block text-[15px] leading-snug font-bold text-warn" data-testid="load-changed">
            {changedText(was, line)}
          </span>
        ) : null}
      </span>
      {line.qty === null ? (
        <span className="max-w-[9rem] shrink-0 text-right text-[15px] leading-snug font-semibold text-ink-2">{qtyText(line)}</span>
      ) : (
        <span className="gauge-m shrink-0 text-right text-[22px] text-ink" data-testid="load-qty">
          {qtyText({ qty: line.qty, unit: line.unit })}
        </span>
      )}
    </CheckRow>
  );
}

function JobHeader({ job, onOpen }: { job: LoadJob; onOpen: () => void }) {
  const days = dayText(job);
  return (
    <li className="rounded-control border-[length:var(--bw)] border-solid border-line p-3">
      <button type="button" onClick={onOpen} className="-m-1 flex min-h-12 w-[calc(100%+0.5rem)] items-center gap-2 rounded-control p-1 text-left hover:bg-sunken">
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] leading-snug font-extrabold text-ink">{job.customer}</span>
          <span className="block text-[16px] font-semibold text-ink-2">
            {job.street}
            {days ? ` · ${days}` : ''}
          </span>
        </span>
        <span className="sr-only">Open the job</span>
        <Icon icon={ChevronRight} className="text-ink" />
      </button>
      <CrewNotesBlock notes={job.notes} className="mt-2" />
    </li>
  );
}

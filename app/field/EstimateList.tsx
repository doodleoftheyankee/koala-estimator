'use client';
// The estimator's home: the estimates on this phone (Daymark field register, mockup-1).
//
//   Header      the KE mark, the title, the one sync state for the phone and a Sync now button
//   Search      name, street or quote number, over the phone's own list (works offline)
//   Board       All / Drafts / Sent / Signed: counts from the same rows, and a filter
//   Sections    Today / This week / Earlier, by last change in the business time zone
//   Rows        customer, street and areas, the saved price and its option, one status badge,
//               one line of activity; rows not yet at the office carry the hazard hatch with
//               "On this phone"
//   Dock        New estimate (the one hi-vis action), with Roof lookup beside it when the menu
//               does not already have it as a tab
//
// What each row says is decided in lib/field/estimateList.ts (tested), never here.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { db, getCachedBundle, type CachedProfile, type LocalEstimate } from '@/lib/offline/db';
import {
  boardCounts,
  bySection,
  matchesFilter,
  matchesSearch,
  onlyInAll,
  phoneSyncState,
  toRows,
  waitingTotal,
  type BoardFilter,
  type EstimateRow,
} from '@/lib/field/estimateList';
import { formatMoney, num, plural, relativeTime } from '@/lib/format';
import {
  Banner,
  Button,
  Dock,
  DockSpacer,
  EmptyState,
  Icon,
  INPUT_CLASS,
  Monogram,
  PlateList,
  SectionHead,
  SignLabel,
  StatusBadge,
  StatusBoard,
  SyncIndicator,
  buttonClass,
  cx,
  CloudOff,
  CloudUpload,
  FilePenLine,
  OctagonAlert,
  Plus,
  RefreshCw,
  Satellite,
  Search,
  TriangleAlert,
  X,
} from '@/components/daymark';
import { useLive } from './hooks';

const FILTER_NAMES: Record<Exclude<BoardFilter, 'all'>, string> = { drafts: 'drafts', sent: 'sent quotes', signed: 'signed quotes' };

/** The current time, ticking each minute so "2 min ago" stays true. */
function useNow(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function EstimateList({
  title,
  profile,
  online,
  syncing,
  lastSync,
  showRoofLookup,
  onOpen,
  onNew,
  onSync,
}: {
  /** The page's name in this role's menu: "Estimates" for an estimator, "Field app" for owner and office. */
  title: string;
  profile: CachedProfile;
  online: boolean;
  /** A sync the person asked for is running. */
  syncing: boolean;
  /** When the phone last read the office's list (ISO), or null. */
  lastSync: string | null;
  /** Put Roof lookup in the dock (when the menu has no Roof lookup tab). */
  showRoofLookup: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSync: () => void;
}) {
  const estimates = useLive(
    () => db().estimates.where('ownerId').equals(profile.userId).toArray(),
    [profile.userId],
    null as LocalEstimate[] | null,
  );
  const bundle = useLive(() => getCachedBundle(), [], undefined as Awaited<ReturnType<typeof getCachedBundle>> | undefined);
  const now = useNow();
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => toRows(estimates ?? [], now), [estimates, now]);
  const counts = boardCounts(rows);
  const waiting = waitingTotal(rows);
  const allOnly = onlyInAll(counts);
  const shown = rows.filter((r) => matchesFilter(r, filter) && matchesSearch(r, query));
  const sync = phoneSyncState(estimates ?? [], { online, syncing, lastSync });

  return (
    <>
      <div className="space-y-4 px-4 pt-4 lg:pt-8">
        <header className="flex items-start gap-3">
          <Monogram size={48} label="" className="mt-0.5 lg:hidden" />
          <div className="min-w-0 flex-1">
            <h1 className="text-[30px] leading-[1.07] font-extrabold tracking-[-0.02em] text-ink">{title}</h1>
            <SyncIndicator
              state={sync.state}
              pending={sync.waiting}
              lastSyncedAt={lastSync}
              now={now.getTime()}
              className="mt-0.5"
            />
          </div>
          <SyncButton online={online} syncing={syncing} onSync={onSync} />
        </header>

        {!online ? (
          <Banner tone="hazard" icon={CloudOff} title="Offline.">
            Saving on this phone.
            {sync.waiting ? ` ${plural(sync.waiting, 'estimate')} will sync when you have signal.` : ''}
            {lastSync ? ` Last synced ${relativeTime(lastSync, now.getTime())}.` : ''}
          </Banner>
        ) : null}
        {bundle === null ? (
          <Banner tone="warn" title="Pricing is not on this phone yet.">
            Open this screen once with signal so estimates can be priced offline.
          </Banner>
        ) : null}

        {estimates === null ? null : rows.length === 0 ? (
          <EmptyState
            icon={FilePenLine}
            title="No estimates on this phone yet"
            hint={
              <>
                Tap <strong className="font-extrabold text-ink">New estimate</strong> to start one at the door. Estimates you open or sync on this phone show up
                here, and they keep working with no signal.
              </>
            }
          />
        ) : (
          <>
            <SearchBox value={query} onChange={setQuery} />
            <div className="space-y-2.5">
              <StatusBoard
                label="Show"
                value={filter}
                onChange={setFilter}
                cells={[
                  { value: 'all', count: num(counts.all), label: 'All' },
                  { value: 'drafts', count: num(counts.drafts), label: 'Drafts' },
                  { value: 'sent', count: num(counts.sent), label: 'Sent' },
                  { value: 'signed', count: num(counts.signed), label: 'Signed' },
                ]}
              />
              {waiting || allOnly ? (
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 text-[15.5px] leading-snug font-semibold text-ink-2">
                  {waiting ? (
                    <span>
                      Waiting to sign{' '}
                      <span data-testid="waiting-total" className="gauge-m text-[20px] text-ink">
                        {formatMoney(waiting.total)}
                      </span> · {plural(waiting.count, 'quote')}
                    </span>
                  ) : null}
                  {allOnly ? <span>All includes {allOnly}.</span> : null}
                </p>
              ) : null}
            </div>

            {shown.length === 0 ? (
              <NothingShown
                query={query}
                filter={filter}
                onClear={() => {
                  setQuery('');
                  setFilter('all');
                }}
              />
            ) : (
              bySection(shown).map((s) => (
                <section key={s.key} aria-labelledby={`sec-${s.key}`} className="space-y-2.5 pt-1">
                  <SectionHead id={`sec-${s.key}`} count={num(s.rows.length)}>
                    {s.label}
                  </SectionHead>
                  <PlateList>
                    {s.rows.map((r) => (
                      <li key={r.id} className="relative">
                        <Row row={r} onOpen={onOpen} />
                      </li>
                    ))}
                  </PlateList>
                </section>
              ))
            )}
          </>
        )}
        <DockSpacer />
      </div>

      <Dock>
        {showRoofLookup ? (
          // A plain page load, so the saved Roof lookup page opens with no signal (public/sw.js).
          <a href="/field/roof" className={buttonClass({ variant: 'secondary', size: 'lg', block: true }, 'no-underline')}>
            <Icon icon={Satellite} />
            Roof lookup
          </a>
        ) : null}
        <Button variant="primary" size="lg" block icon={Plus} onClick={onNew}>
          New estimate
        </Button>
      </Dock>
    </>
  );
}

function SyncButton({ online, syncing, onSync }: { online: boolean; syncing: boolean; onSync: () => void }) {
  const label = online ? 'Sync now' : 'Sync now (needs signal)';
  return (
    <button
      type="button"
      onClick={onSync}
      disabled={!online}
      aria-label={label}
      title={label}
      aria-busy={syncing || undefined}
      className={buttonClass({ variant: 'secondary', size: 'md', disabled: !online }, 'w-14 shrink-0 px-0')}
    >
      <Icon icon={RefreshCw} className={syncing ? 'motion-safe:animate-spin motion-safe:[animation-duration:1.6s]' : undefined} />
    </button>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div role="search" className="relative">
      <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-2">
        <Icon icon={Search} />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search estimates"
        placeholder="Name, street or quote no."
        autoComplete="off"
        enterKeyHint="search"
        className={cx(INPUT_CLASS, 'border-edge pr-14 pl-12 [&::-webkit-search-cancel-button]:hidden')}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          title="Clear search"
          className="absolute top-1/2 right-1 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-control text-ink hover:bg-sunken"
        >
          <Icon icon={X} />
        </button>
      ) : null}
    </div>
  );
}

function NothingShown({ query, filter, onClear }: { query: string; filter: BoardFilter; onClear: () => void }) {
  const what = filter === 'all' ? 'estimates' : FILTER_NAMES[filter];
  return (
    <div className="plate flex flex-col items-start gap-3 p-4">
      <p className="text-[18px] font-extrabold text-ink">{query.trim() ? `No ${what} match “${query.trim()}”` : `No ${what} on this phone`}</p>
      <Button size="sm" onClick={onClear}>
        Show all estimates
      </Button>
    </div>
  );
}

function SyncMark({ sync }: { sync: EstimateRow['sync'] }) {
  const mark: Record<Exclude<EstimateRow['sync'], 'synced'>, { icon: typeof CloudUpload; tone: string; word: string }> = {
    phone: { icon: CloudUpload, tone: 'text-warn', word: 'On this phone' },
    conflict: { icon: TriangleAlert, tone: 'text-bad', word: 'Conflict' },
    invalid: { icon: OctagonAlert, tone: 'text-bad', word: 'Needs fixing' },
  };
  if (sync === 'synced') return null;
  const m = mark[sync];
  return (
    <span className={cx('ml-auto inline-flex items-center gap-1.5 text-[15.5px] font-extrabold', m.tone)}>
      <Icon icon={m.icon} size="s" />
      {m.word}
    </span>
  );
}

function Row({ row, onOpen }: { row: EstimateRow; onOpen: (id: string) => void }) {
  const unsynced = row.sync !== 'synced';
  let price: ReactNode = null;
  if (row.price !== null) {
    price = (
      <span className="flex shrink-0 flex-col items-end gap-1 text-right">
        <span data-testid="row-price" className="gauge text-[34px] text-ink">
          {formatMoney(row.price)}
        </span>
        <SignLabel size={11.5}>{row.priceLabel}</SignLabel>
      </span>
    );
  } else if (row.unpriceable) {
    price = <span className="shrink-0 pt-0.5 text-[16px] font-bold text-ink-3">Not priced</span>;
  }
  return (
    <>
      {unsynced ? <span aria-hidden className="hatch absolute inset-y-0 left-0 w-[7px]" /> : null}
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        data-status={row.status}
        className={cx('block w-full py-3.5 pr-4 text-left hover:bg-sunken focus-visible:-outline-offset-4 active:bg-sunken', unsynced ? 'pl-6' : 'pl-4')}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="block min-w-0">
            <span className="block truncate text-[20px] leading-tight font-extrabold text-ink">{row.name}</span>
            <span className="mt-1 block truncate text-[16px] font-medium text-ink-2">
              {row.street ?? 'No address yet'}
              {row.areas ? ` · ${row.areas}` : ''}
            </span>
          </span>
          {price}
        </span>
        <span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusBadge status={row.status} />
          <span className="min-w-0 text-[15.5px] font-semibold text-ink-2">{row.activity}</span>
          <SyncMark sync={row.sync} />
        </span>
      </button>
    </>
  );
}

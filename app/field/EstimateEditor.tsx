'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { priceEstimate, type PricedEstimate } from '@/lib/pricing';
import { computeDeviationFlags } from '@/lib/learning/deviation';
import type { DeviationFlag } from '@/lib/learning/types';
import { db, getCachedBundle, type CachedProfile, type LocalEstimate } from '@/lib/offline/db';
import { resolveConflict, touch } from '@/lib/offline/syncCore';
import { priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { withDraftDefaults } from '@/lib/field/draft';
import { ackSummary } from '@/lib/field/flags';
import { formatMoney, TIER_LABELS } from '@/lib/format';
import {
  Banner,
  Button,
  Dock,
  DockSpacer,
  LoadingSteps,
  SignLabel,
  SyncIndicator,
  cx,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Icon,
  Lock,
  TriangleAlert,
  type SyncState as IndicatorState,
} from '@/components/daymark';
import { useLive } from './hooks';
import { CustomerStep } from './CustomerStep';
import { AreasStep } from './AreasStep';
import { OptionsStep } from './OptionsStep';
import { SendStep } from './SendStep';

const STEPS = [
  { key: 'customer', label: 'Customer' },
  { key: 'areas', label: 'Areas' },
  { key: 'options', label: 'Options' },
  { key: 'send', label: 'Send' },
] as const;
type Step = (typeof STEPS)[number]['key'];

export type PricingResult = { ok: PricedEstimate; error: null } | { ok: null; error: string } | null;
export type Update = (fn: (d: EstimateDraft) => EstimateDraft) => void;

const SAVE_DELAY_MS = 400;

export function EstimateEditor({
  id,
  profile,
  online,
  onBack,
  requestSync,
}: {
  id: string;
  profile: CachedProfile;
  online: boolean;
  onBack: () => void;
  requestSync: () => void;
}) {
  const record = useLive(() => db().estimates.get(id), [id], undefined as LocalEstimate | undefined);
  const bundle = useLive(() => getCachedBundle(), [], null);
  const [draft, setDraft] = useState<EstimateDraft | null>(null);
  const [step, setStep] = useState<Step>('customer');

  const latest = useRef<EstimateDraft | null>(null);
  const savedMutation = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt the stored copy on first load and whenever it changes from outside this editor
  // (sync pull, conflict resolution, quote sent) while there are no unsaved keystrokes.
  useEffect(() => {
    if (!record) return;
    if (savedMutation.current === null || (record.mutationId !== savedMutation.current && timer.current === null)) {
      savedMutation.current = record.mutationId;
      const adopted = withDraftDefaults(record.draft);
      latest.current = adopted;
      setDraft(adopted);
    }
  }, [record]);

  const priced: PricingResult = useMemo(() => {
    if (!bundle || !draft) return null;
    const areas = priceableAreas(draft);
    if (areas.length === 0) return null;
    try {
      return { ok: priceEstimate({ ...toEstimateInput(draft), areas }, bundle.snapshot, bundle.coefficientSet), error: null };
    } catch (e) {
      return { ok: null, error: (e as Error).message };
    }
  }, [draft, bundle]);

  // Deviation flags (PLAN.md §6.5), computed on the phone so they work offline. The server
  // recomputes them on sync and before sending; a failure here must never block editing.
  const flags: DeviationFlag[] = useMemo(() => {
    if (!bundle || !draft || !priced?.ok) return [];
    try {
      return computeDeviationFlags(priced.ok, { ...toEstimateInput(draft), areas: priceableAreas(draft) }, bundle);
    } catch (e) {
      console.error('[field] deviation flags failed', e);
      return [];
    }
  }, [priced, draft, bundle]);

  // The headline price: the recommended option (the one chosen on Options, else Better, else the
  // first), saved with its option so the list can say which one it is.
  const summary = useMemo(() => {
    const opts = priced?.ok?.options ?? [];
    const o = opts.find((x) => x.tier === draft?.selectedTier) ?? opts.find((x) => x.tier === 'better') ?? opts[0];
    return o ? { price: o.price, tier: o.tier } : null;
  }, [priced, draft?.selectedTier]);
  const summaryRef = useRef(summary);
  useEffect(() => {
    summaryRef.current = summary;
  }, [summary]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = latest.current;
    if (!next) return;
    const mutationId = crypto.randomUUID();
    savedMutation.current = mutationId;
    let pending = false;
    await db().transaction('rw', db().estimates, async () => {
      const cur = await db().estimates.get(id);
      if (!cur || cur.syncState === 'locked') return;
      // Server-owned fields always come from the stored record, never from the form state.
      const merged: EstimateDraft = {
        ...next,
        rowVersion: cur.draft.rowVersion,
        bundleHash: cur.draft.bundleHash,
        lastQuote: cur.draft.lastQuote,
        status: cur.draft.status,
      };
      const updated = {
        ...touch(cur, merged, mutationId, new Date().toISOString()),
        summaryPrice: summaryRef.current?.price ?? null,
        summaryTier: summaryRef.current?.tier ?? null,
      };
      pending = updated.syncState === 'pending';
      await db().estimates.put(updated);
    });
    if (pending && navigator.onLine) {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(requestSync, 2500);
    }
  }, [id, requestSync]);

  const update: Update = useCallback(
    (fn) => {
      setDraft((d) => {
        if (!d) return d;
        const next = fn(d);
        latest.current = next;
        return next;
      });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  // Save on leave / app backgrounding so nothing typed is lost. Only unsaved typing is written:
  // saving an untouched estimate would turn a sent quote back into a draft (touch() starts a new
  // revision) and send that to the office.
  const flushIfDirty = useCallback(async () => {
    if (timer.current !== null) await flush();
  }, [flush]);
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && void flushIfDirty();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void flushIfDirty();
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [flushIfDirty]);

  if (record === undefined || !draft) {
    return (
      <div className="px-4 pt-6">
        <LoadingSteps steps={[{ label: 'Opening the estimate', state: 'doing' }]} />
      </div>
    );
  }

  const locked = record.syncState === 'locked' || draft.status === 'signed';
  const name = `${draft.customer.firstName} ${draft.customer.lastName}`.trim() || 'New estimate';
  const street = draft.property.street.trim();
  const address = street ? [street, draft.property.city.trim()].filter(Boolean).join(', ') : 'No address yet';
  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const prev = stepIndex > 0 ? STEPS[stepIndex - 1]! : null;
  const next = stepIndex < STEPS.length - 1 ? STEPS[stepIndex + 1]! : null;
  const toExplain = ackSummary(flags, draft.deviationAcks).pending;
  const goTo = (k: Step) => {
    setStep(k);
    window.scrollTo(0, 0);
  };

  async function resolve(choice: 'mine' | 'theirs') {
    await db().transaction('rw', db().estimates, async () => {
      const cur = await db().estimates.get(id);
      if (cur) await db().estimates.put(resolveConflict(cur, choice, crypto.randomUUID()));
    });
    if (choice === 'mine') requestSync();
  }

  return (
    <>
      <header className="sticky top-0 z-20 border-b-[length:var(--bw)] border-solid border-line bg-canvas px-4 pt-3 pb-1">
        <div className="flex items-center gap-3">
          <Button
            icon={ArrowLeft}
            aria-label="Back to estimates"
            title="Back to estimates"
            className="w-14 shrink-0 px-0"
            onClick={async () => {
              await flushIfDirty();
              onBack();
            }}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[22px] leading-tight font-extrabold tracking-[-0.01em] text-ink">{name}</h1>
            <p className="truncate text-[15.5px] font-semibold text-ink-2">{address}</p>
          </div>
          <SyncIndicator state={recordSyncState(record, online)} className="shrink-0" />
        </div>
        <StepNav current={stepIndex} toExplain={toExplain} onStep={goTo} />
      </header>

      <div className="space-y-3 px-4 py-4">
        {locked ? (
          <Banner tone="ok" icon={Lock} title="The customer signed this quote." live={false}>
            It is read-only.
          </Banner>
        ) : null}
        {record.syncState === 'conflict' ? (
          <Banner
            tone="bad"
            title="This estimate was changed on another device."
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => resolve('mine')}>
                  Keep mine
                </Button>
                <Button size="sm" onClick={() => resolve('theirs')}>
                  Use the other version
                </Button>
              </div>
            }
          >
            Choose which version to keep.
          </Banner>
        ) : null}
        {record.syncState === 'invalid' && record.lastError ? (
          <Banner tone="bad" title="The office could not save this estimate.">
            {record.lastError}
          </Banner>
        ) : null}
        {!bundle ? (
          <Banner tone="warn" title="Pricing is not on this phone yet.">
            Connect once to price estimates.
          </Banner>
        ) : null}

        <fieldset disabled={locked} className="m-0 min-w-0 space-y-3 border-0 p-0">
          {step === 'customer' ? <CustomerStep draft={draft} update={update} /> : null}
          {step === 'areas' ? <AreasStep draft={draft} update={update} bundle={bundle} ownerId={profile.userId} /> : null}
          {step === 'options' ? (
            <OptionsStep draft={draft} update={update} bundle={bundle} priced={priced} flags={flags} profile={profile} online={online} />
          ) : null}
        </fieldset>
        {step === 'send' ? (
          <SendStep
            draft={draft}
            record={record}
            priced={priced}
            flags={flags}
            bundle={bundle}
            profile={profile}
            online={online}
            flush={flush}
            locked={locked}
            onReviewOptions={() => goTo('options')}
          />
        ) : null}
        <DockSpacer />
      </div>

      <Dock label="Estimate actions">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SignLabel size={11}>{summary ? 'Recommended' : 'Price'}</SignLabel>
            <p className="mt-1 flex min-w-0 items-baseline gap-2">
              <span className="gauge-m text-[26px] text-ink">{summary ? formatMoney(summary.price) : '—'}</span>
              {summary ? (
                <SignLabel size={11} tone="ink" className="truncate">
                  {TIER_LABELS[summary.tier]}
                </SignLabel>
              ) : (
                <span className="sr-only">Not priced yet</span>
              )}
            </p>
          </div>
          {prev ? (
            <Button
              size="lg"
              icon={ChevronLeft}
              aria-label={`Previous step: ${prev.label}`}
              title={`Previous: ${prev.label}`}
              className="w-16 shrink-0 px-0"
              onClick={() => goTo(prev.key)}
            />
          ) : null}
          {next ? (
            <Button variant="primary" size="lg" iconEnd={ChevronRight} className="shrink-0 pr-4" onClick={() => goTo(next.key)}>
              Next<span className="sr-only">: {next.label}</span>
            </Button>
          ) : null}
        </div>
      </Dock>
    </>
  );
}

/** This estimate's sync state, in the header's words. */
function recordSyncState(record: LocalEstimate, online: boolean): IndicatorState {
  switch (record.syncState) {
    case 'synced':
    case 'locked':
      return 'synced';
    case 'conflict':
      return 'conflict';
    case 'invalid':
      return 'error';
    default:
      return online ? 'pending' : 'offline';
  }
}

/**
 * The four steps as a track you can tap: done steps are ink, the current one is ink with a ring,
 * the rest use the track colour. Options carries the count of changes still to explain.
 */
function StepNav({ current, toExplain, onStep }: { current: number; toExplain: number; onStep: (k: Step) => void }) {
  return (
    <nav aria-label="Estimate steps" className="mt-2.5">
      {/* Columns sized to their labels, so "1 Customer" fits a 390px phone at 15px. */}
      <ol className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.8fr)] gap-1.5">
        {STEPS.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'todo';
          const explain = s.key === 'options' && toExplain > 0;
          return (
            <li key={s.key} className="min-w-0">
              <button
                type="button"
                onClick={() => onStep(s.key)}
                aria-current={state === 'current' ? 'step' : undefined}
                className="relative block min-h-12 w-full rounded-control px-0.5 pt-1.5 pb-1 text-left focus-visible:outline-offset-0"
              >
                <span
                  aria-hidden
                  className={cx(
                    'block h-[7px] rounded-full',
                    state === 'todo' ? 'bg-track shadow-[inset_0_0_0_2px_var(--track-edge)]' : 'bg-ink',
                    state === 'current' && 'outline-2 outline-offset-2 outline-ink outline-solid',
                  )}
                />
                {explain ? (
                  // Sits over the end of the bar, so the step's name keeps its room.
                  <span
                    aria-hidden
                    className="absolute -top-1 right-0 inline-flex h-6 items-center gap-0.5 rounded-full border-[1.5px] border-solid border-warn bg-warn-fill px-1.5 font-num text-[15px] leading-none font-extrabold text-warn"
                  >
                    <Icon icon={TriangleAlert} size="xs" />
                    {toExplain}
                  </span>
                ) : null}
                <span className={cx('mt-2 block min-w-0 truncate text-[15px] leading-tight', state === 'todo' ? 'font-semibold text-ink-3' : 'font-extrabold text-ink')}>
                  <span className="font-num [font-stretch:80%]">{i + 1}</span> {s.label}
                  <span className="sr-only">
                    {explain ? ` (${toExplain} to explain)` : ''}
                    {state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

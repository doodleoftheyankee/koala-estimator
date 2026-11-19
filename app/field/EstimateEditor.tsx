'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { priceEstimate, type PricedEstimate } from '@/lib/pricing';
import { computeDeviationFlags } from '@/lib/learning/deviation';
import type { DeviationFlag } from '@/lib/learning/types';
import { db, getCachedBundle, type CachedProfile, type LocalEstimate } from '@/lib/offline/db';
import { resolveConflict, touch, UNSENT_CHANGE_DROPPED } from '@/lib/offline/syncCore';
import { draftSchema, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { withDraftDefaults } from '@/lib/field/draft';
import { ackSummary } from '@/lib/field/flags';
import { formatMoney, TIER_LABELS } from '@/lib/format';
import { recommendedTier } from '@/lib/field/recommended';
import { fixElementId, type FixTarget } from '@/lib/field/fix';
import {
  Banner,
  Button,
  Dock,
  DockSpacer,
  LoadingSteps,
  SignLabel,
  StepTrack,
  SyncIndicator,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Lock,
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
const STEP_LABELS = STEPS.map((s) => s.label);
const OPTIONS_STEP = STEPS.findIndex((s) => s.key === 'options');

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
  const router = useRouter();
  // Where the last Fix button from the Send checklist pointed (the step opens there).
  const [focus, setFocus] = useState<FixTarget | null>(null);

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

  // The headline price: the recommended option (the one chosen on Options, else Better; when that
  // one is not shown, the option doing the same work, else the nearest above, else below: OD15),
  // saved with its option so the list can say which one it is.
  const summary = useMemo(() => {
    const opts = priced?.ok?.options ?? [];
    const rec = recommendedTier(opts, draft?.selectedTier);
    const o = rec ? opts.find((x) => x.tier === rec.tier) : undefined;
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

  // After a Fix opens its step, bring the field, area or option into view (and focus a field).
  useEffect(() => {
    if (!focus || focus.step !== step) return;
    const id = fixElementId(focus);
    const frame = requestAnimationFrame(() => {
      const el = id ? document.getElementById(id) : null;
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      if (el instanceof HTMLInputElement) el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, step]);

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
  // Steps can be tapped in any order, so a step is done only when its part of the estimate is:
  // the customer and address the server needs, a priced area, priced options with one picked as
  // recommended and nothing left to explain, and a quote that went out.
  const sent = draft.status === 'sent' || draft.status === 'viewed' || draft.status === 'signed';
  const stepDone: Record<Step, boolean> = {
    customer: draftSchema.shape.customer.safeParse(draft.customer).success && draftSchema.shape.property.safeParse(draft.property).success,
    areas: priceableAreas(draft).length > 0,
    options: (priced?.ok?.options.length ?? 0) > 0 && toExplain === 0 && (draft.selectedTier !== null || sent),
    send: sent,
  };
  const goTo = (k: Step) => {
    setFocus(null);
    setStep(k);
    window.scrollTo(0, 0);
  };
  /** A Fix button: open the step (or the Business profile page) at the item to fix. */
  const fix = (t: FixTarget) => {
    if (t.step === 'business') {
      router.push('/admin/business');
      return;
    }
    setFocus(t);
    setStep(t.step);
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
        <StepTrack
          label="Estimate steps"
          className="mt-2.5"
          steps={STEP_LABELS}
          current={stepIndex}
          done={STEPS.map((s) => stepDone[s.key])}
          onStep={(i) => goTo(STEPS[i]!.key)}
          badges={toExplain > 0 ? { [OPTIONS_STEP]: { count: toExplain, label: `${toExplain} to explain` } } : undefined}
          // Columns sized to their labels, so "1 Customer" fits a 390px phone at 15px.
          columns="minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.1fr) minmax(0,0.8fr)"
        />
      </header>

      <div className="space-y-3 px-4 py-4">
        {locked ? (
          <Banner tone="ok" icon={Lock} title="The customer signed this quote." live={record.lastError === UNSENT_CHANGE_DROPPED}>
            It is read-only.{record.syncState === 'locked' && record.lastError === UNSENT_CHANGE_DROPPED ? ` ${UNSENT_CHANGE_DROPPED}` : null}
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
          {step === 'areas' ? <AreasStep draft={draft} update={update} bundle={bundle} ownerId={profile.userId} focus={focus} /> : null}
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
            onFix={fix}
          />
        ) : null}
        <DockSpacer />
      </div>

      <Dock label="Estimate actions">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SignLabel size={11}>{summary ? 'Recommended' : 'Price'}</SignLabel>
            <p className="mt-1 flex min-w-0 items-baseline gap-2">
              <span className="gauge-m text-[26px] text-ink">{summary ? formatMoney(summary.price, { cents: 'never' }) : '—'}</span>
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

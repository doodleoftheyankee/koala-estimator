'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { priceEstimate, type PricedEstimate } from '@/lib/pricing';
import { db, getCachedBundle, type CachedProfile, type LocalEstimate } from '@/lib/offline/db';
import { resolveConflict, touch } from '@/lib/offline/syncCore';
import { priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { usd } from '@/lib/format';
import { Alert, Badge, Button, cx } from '@/components/ui';
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
      latest.current = record.draft;
      setDraft(record.draft);
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

  const summaryPrice = useMemo(() => {
    const opts = priced?.ok?.options ?? [];
    return (opts.find((o) => o.tier === draft?.selectedTier) ?? opts.find((o) => o.tier === 'better') ?? opts[0])?.price ?? null;
  }, [priced, draft?.selectedTier]);
  const summaryRef = useRef(summaryPrice);
  useEffect(() => {
    summaryRef.current = summaryPrice;
  }, [summaryPrice]);

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
      const updated = { ...touch(cur, merged, mutationId, new Date().toISOString()), summaryPrice: summaryRef.current };
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

  // Save on leave / app backgrounding so nothing typed is lost.
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && void flush();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void flush();
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [flush]);

  if (record === undefined || !draft) return <div className="p-6 text-center text-slate-500">Loading estimate…</div>;

  const locked = record.syncState === 'locked' || draft.status === 'signed';
  const name = `${draft.customer.firstName} ${draft.customer.lastName}`.trim() || 'New estimate';
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  async function resolve(choice: 'mine' | 'theirs') {
    await db().transaction('rw', db().estimates, async () => {
      const cur = await db().estimates.get(id);
      if (cur) await db().estimates.put(resolveConflict(cur, choice, crypto.randomUUID()));
    });
    if (choice === 'mine') requestSync();
  }

  return (
    <div className="pb-40">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-2 px-2 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await flush();
              onBack();
            }}
            aria-label="Back to estimates"
          >
            ‹ Back
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{name}</p>
            <p className="truncate text-xs text-slate-500">{draft.property.street || 'No address'}</p>
          </div>
          <SyncBadge record={record} online={online} />
        </div>
        <nav className="flex border-t border-slate-100" aria-label="Estimate steps">
          {STEPS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStep(s.key)}
              aria-current={step === s.key ? 'step' : undefined}
              className={cx(
                'flex-1 border-b-2 py-2.5 text-sm font-semibold',
                step === s.key ? 'border-brand-700 text-brand-800' : 'border-transparent text-slate-500',
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="space-y-3 p-3">
        {locked ? <Alert tone="blue">The customer signed this quote. It is read-only.</Alert> : null}
        {record.syncState === 'conflict' ? (
          <Alert tone="red">
            <p className="font-semibold">This estimate was changed on another device.</p>
            <p className="mb-2">Choose which version to keep.</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => resolve('mine')}>
                Keep mine
              </Button>
              <Button size="sm" variant="secondary" onClick={() => resolve('theirs')}>
                Use the other version
              </Button>
            </div>
          </Alert>
        ) : null}
        {record.syncState === 'invalid' && record.lastError ? <Alert tone="red">Server rejected this estimate: {record.lastError}</Alert> : null}
        {!bundle ? <Alert tone="amber">Pricing has not been downloaded to this phone yet. Connect once to price estimates.</Alert> : null}

        <fieldset disabled={locked} className="m-0 min-w-0 space-y-3 border-0 p-0">
          {step === 'customer' ? <CustomerStep draft={draft} update={update} /> : null}
          {step === 'areas' ? <AreasStep draft={draft} update={update} bundle={bundle} /> : null}
          {step === 'options' ? <OptionsStep draft={draft} update={update} bundle={bundle} priced={priced} profile={profile} online={online} /> : null}
        </fieldset>
        {step === 'send' ? (
          <SendStep draft={draft} record={record} priced={priced} bundle={bundle} profile={profile} online={online} flush={flush} locked={locked} />
        ) : null}
      </div>

      <footer className="safe-bottom fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white px-3 pt-2">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-500">{priced?.ok ? 'Recommended option' : 'Price'}</p>
            <p className="text-xl font-bold">{summaryPrice !== null ? usd(summaryPrice) : '—'}</p>
          </div>
          {stepIndex > 0 ? (
            <Button variant="secondary" onClick={() => setStep(STEPS[stepIndex - 1]!.key)}>
              Back
            </Button>
          ) : null}
          {stepIndex < STEPS.length - 1 ? <Button onClick={() => setStep(STEPS[stepIndex + 1]!.key)}>Next</Button> : null}
        </div>
      </footer>
    </div>
  );
}

function SyncBadge({ record, online }: { record: LocalEstimate; online: boolean }) {
  switch (record.syncState) {
    case 'synced':
      return <Badge tone="green">Synced</Badge>;
    case 'locked':
      return <Badge tone="blue">Signed</Badge>;
    case 'conflict':
      return <Badge tone="red">Conflict</Badge>;
    case 'invalid':
      return <Badge tone="red">Needs fixing</Badge>;
    case 'local':
      return <Badge tone="slate">Saved on phone</Badge>;
    default:
      return <Badge tone="amber">{online ? 'Syncing…' : 'Saved on phone'}</Badge>;
  }
}

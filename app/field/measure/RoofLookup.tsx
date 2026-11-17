'use client';
// "Look up from the address": the roof takeoff for an area. The Roof Takeoff service finds the house
// on Google's aerial photo and measures the roof; this sheet shows the outline and the roof edges on
// the photo and the number the area needs (attic floor or roof deck, crawlspace floor, garage
// ceiling or wall run), with what to check on site right under it, then the roofing numbers and
// materials (RoofTakeoff). The estimator sets the overhang, picks the roof faces that count, can
// tap the right roof when Google picked the wrong house, and uses the number. Nothing changes in
// the estimate until Use.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AreaDraft } from '@/lib/sync/draft';
import type { Measurement } from '@/lib/measure/measure';
import {
  JOB_WORDS,
  noteLine,
  NOT_CONFIGURED_MESSAGE,
  offersUnmatched,
  PICK_WORDS,
  roofJob,
  roundFt,
  roundSqft,
  startPick,
  type RoofChoices,
  type RoofFigures,
  type RoofJob,
  type RoofPick,
  type RoofResult,
} from '@/lib/roof/lookup';
import { roofLookupService, setAreaPick, useAreaPick, useHouseLookup } from '@/lib/offline/roofLookup';
import { Button, cx } from '@/components/ui';
import { useOnline } from '../hooks';
import { comma, TakeoffBody, useTakeoff } from './RoofTakeoff';

/** The area form's limit on square feet. */
const MAX_SQFT = 200_000;

/** What Use puts into the area; `what` names the number in the confirmation ("roof deck"). */
export type RoofApply = { use: 'floor' | 'deck'; sqft: number; what: string; note: string } | { use: 'walls'; wallRunFt: number; note: string };

/** Whether the lookup is switched on on the server (asked only when it could be used). */
export function useRoofConfigured(ask: boolean): boolean {
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void roofLookupService().then((r) => live && setConfigured(r.configured));
    return () => {
      live = false;
    };
  }, [ask]);
  return configured;
}

/** The button under Measure on an area, with why it can't be used yet. */
export function RoofLookupButton({ estimateId, address, street, onOpen }: { estimateId: string; address: string | null; street: string; onOpen: () => void }) {
  const online = useOnline();
  const state = useHouseLookup(estimateId, address);
  // Ask the server whether the lookup is on only when it could be used (signal and an address).
  const configured = useRoofConfigured(online && Boolean(address));
  const reason = !online
    ? 'No signal. The satellite lookup needs a connection.'
    : !address
      ? 'Fill in the street, city, state and ZIP first (Customer step).'
      : !configured
        ? NOT_CONFIGURED_MESSAGE
        : null;
  const hint = state.running
    ? `Looking up ${street.trim()}…`
    : state.last
      ? `Looked up ${street.trim()} on this visit. Tap to see it again.`
      : `Measures ${street.trim()} from Google's aerial photo: attic floor, roof deck, wall run and the roof for roofing.`;
  return (
    <div className="space-y-1">
      <Button variant="secondary" size="lg" className="w-full" disabled={Boolean(reason)} onClick={onOpen}>
        🛰️ Look up from the address
      </Button>
      <p className={cx('text-xs', reason ? 'text-slate-600' : 'text-slate-500')}>{reason ?? hint}</p>
    </div>
  );
}

/** What Use would apply for this area, or why it can't yet. */
function applyFor(result: RoofResult, f: RoofFigures, choices: RoofChoices, job: RoofJob, pick: RoofPick): { apply: RoofApply; label: string } | { reason: string } {
  if (job === 'walls') {
    if (f.wallRunFt === null) return { reason: "No outline was found, so there's no wall run. Measure the walls on site." };
    const ft = roundFt(f.wallRunFt);
    if (ft <= 0) return { reason: 'Nothing to use: turn on some roof faces.' };
    return { apply: { use: 'walls', wallRunFt: ft, note: noteLine(result, f, choices, job) }, label: `Use ${comma(ft)} ft as the wall run` };
  }
  if (job === 'garage' && f.facesKept === 0 && !(offersUnmatched(result, job) && !choices.unmatchedOut)) return { reason: "Turn on the garage's roof faces." };
  const deck = job === 'attic' && pick === 'deck';
  if (deck && f.deckSqft === null) return { reason: 'Turn on at least one roof face for the roof deck.' };
  const sqft = roundSqft(deck ? f.deckSqft! : f.floorSqft);
  if (sqft <= 0) return { reason: 'Nothing to use: turn on some roof faces.' };
  if (sqft > MAX_SQFT) return { reason: 'Too big for one area. Measure it by hand.' };
  const what = deck ? PICK_WORDS.deck.note : JOB_WORDS[job].number.toLowerCase();
  return { apply: { use: deck ? 'deck' : 'floor', sqft, what, note: noteLine(result, f, choices, job, pick) }, label: `Use ${comma(sqft)} sq ft` };
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function RoofLookupSheet({
  area,
  measurement,
  estimateId,
  address,
  onApply,
  onClose,
}: {
  area: AreaDraft;
  measurement: Measurement | undefined;
  estimateId: string;
  /** The address to look up (complete; see lookupAddress). */
  address: string;
  onApply: (a: RoofApply) => void;
  onClose: () => void;
}) {
  const job: RoofJob = roofJob(area.jobType) ?? 'attic';
  const t = useTakeoff({ estimateId, areaId: area.id, address, job });
  const { state, result, f, choices } = t;
  const chosen = useAreaPick(area.id);
  const pick: RoofPick = job === 'attic' ? (chosen ?? startPick(measurement)) : 'floor';

  // Opening the sheet looks the house up, unless this visit already did (or is doing) it, on any
  // area, or it just failed (then the error shows with Try again, rather than paying again unasked).
  useEffect(() => {
    if (!state.running && !state.last && !state.error) t.start();
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus moves into the sheet when it opens and back to what opened it when it closes; the page
  // behind it doesn't scroll; Escape closes it on a keyboard.
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  /** Tab stays inside the sheet (it is modal). */
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!;
    const lastItem = items.at(-1)!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog.current)) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && active === lastItem) {
      e.preventDefault();
      first.focus();
    }
  };

  const use = result && f && choices ? applyFor(result, f, choices, job, pick) : null;
  const blocked = t.needsConfirm ? 'Check the house on the photo first: tap “Yes, this is the house”.' : use && 'reason' in use ? use.reason : null;

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`Roof takeoff for ${area.name}`}
      tabIndex={-1}
      onKeyDown={trapTab}
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-slate-100 outline-none"
    >
      <div className="sticky top-0 z-10 bg-white shadow-sm" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold leading-tight">🛰️ Roof takeoff</h2>
            <p className="truncate text-xs text-slate-600">{area.name}</p>
          </div>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        {f ? <Numbers f={f} job={job} pick={pick} onPick={(p) => setAreaPick(area.id, p)} /> : null}
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-4">
        <TakeoffBody t={t} mode="area" label={address} />
      </div>

      {result && use && t.picking === 'off' ? (
        <div className="sticky bottom-0 z-10 bg-white/95 shadow-[0_-1px_4px_rgba(15,23,42,0.08)] backdrop-blur safe-bottom">
          <div className="mx-auto max-w-2xl px-4 pt-3">
            <Button size="lg" className="w-full" disabled={Boolean(blocked) || !('apply' in use)} onClick={() => 'apply' in use && !blocked && onApply(use.apply)}>
              {'apply' in use ? use.label : 'Use'}
            </Button>
            <p className={cx('mt-1 text-center text-xs', blocked ? 'font-medium text-amber-800' : 'text-slate-500')}>
              {blocked ??
                (job === 'walls' ? 'Sets the wall run in Measure; you add the wall height.' : `The ${'apply' in use && use.apply.use !== 'walls' ? use.apply.what : 'number'} goes into Square feet, with a line in the prep notes.`)}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The number the area takes, big and kept in view; attic and commercial areas choose between two. */
function Numbers({ f, job, pick, onPick }: { f: RoofFigures; job: RoofJob; pick: RoofPick; onPick: (p: RoofPick) => void }) {
  const value = (n: number | null, unit: string, round: (n: number) => number) => (
    <span className="whitespace-nowrap text-3xl font-extrabold tabular-nums">
      {n === null ? '—' : comma(round(n))}
      {n === null ? null : <span className="ml-1 text-sm font-semibold">{unit}</span>}
    </span>
  );
  if (job === 'attic') {
    const option = (p: RoofPick, n: number | null) => {
      const on = pick === p;
      return (
        <button
          type="button"
          role="radio"
          aria-checked={on}
          onClick={() => onPick(p)}
          className={cx('flex min-w-0 flex-col items-start rounded-xl px-3 py-2 text-left ring-1 transition-colors', on ? 'bg-brand-50 text-brand-800 ring-2 ring-brand-600' : 'bg-white text-slate-700 ring-slate-300')}
        >
          <span className="flex items-start gap-1.5 text-xs font-semibold leading-tight">
            <span aria-hidden className={cx('mt-0.5 h-3 w-3 shrink-0 rounded-full ring-2', on ? 'bg-brand-600 ring-brand-600' : 'ring-slate-400')} />
            {PICK_WORDS[p].label}
          </span>
          {value(n, 'sq ft', roundSqft)}
        </button>
      );
    };
    return (
      <div className="mx-auto max-w-2xl px-4 pb-2">
        <div role="radiogroup" aria-label="Which number to use" className="grid grid-cols-2 gap-2">
          {option('floor', f.floorSqft)}
          {option('deck', f.deckSqft)}
        </div>
        <p className="mt-1.5 text-xs leading-snug text-slate-600">Top-floor ceiling seen from above. Finished attic rooms, cathedral ceilings and knee walls need measuring on site.</p>
      </div>
    );
  }
  const garageEmpty = job === 'garage' && f.facesKept === 0 && f.floorSqft === 0;
  const hint =
    job === 'crawlspace'
      ? 'The house footprint inside the walls. Leave out the garage and porch.'
      : job === 'garage'
        ? garageEmpty
          ? "Turn on the garage's roof faces."
          : 'From the roof faces turned on below.'
        : `${f.wallRunRough ? "Rough: from the building's size. " : ''}Porch and garage walls count unless their faces are off.`;
  return (
    <div className="mx-auto max-w-2xl px-4 pb-2">
      <div className="rounded-xl bg-brand-50 px-3 py-1.5 text-brand-800">
        <div className="text-xs font-bold uppercase tracking-wide">
          {JOB_WORDS[job].number}
          {job === 'walls' && f.wallRunRough ? <span className="ml-2 font-semibold normal-case tracking-normal text-amber-800">rough: from the building&apos;s size</span> : null}
        </div>
        {job === 'walls' ? value(f.wallRunFt, 'ft', roundFt) : value(garageEmpty ? null : f.floorSqft, 'sq ft', roundSqft)}
      </div>
      <p className={cx('mt-1.5 text-xs leading-snug', garageEmpty ? 'font-semibold text-amber-800' : 'text-slate-600')}>{hint}</p>
    </div>
  );
}

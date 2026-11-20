'use client';
// "Look up from the address": the roof takeoff for an area, in the Daymark field register. The
// Roof Takeoff service finds the house on Google's aerial photo and measures the roof. The sheet
// opens on the photo and the house check ("Right house" / "Tap the right roof"), then the number
// the area needs: readout tiles for an attic (attic floor or roof deck, the chosen one hi-vis),
// one reading for a crawlspace floor, a garage ceiling or a wall run. The rest is RoofTakeoff's:
// what to check on site, the overhang and faces, More details. The dock repeats the chosen value
// ("Use 1,970 sq ft"). Nothing changes in the estimate until Use.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
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
import { num } from '@/lib/format';
import { Button, cx, Dock, Icon, IconButton, ReadoutTiles, Satellite, SignLabel, TriangleAlert, X } from '@/components/daymark';
import { useOnline } from '../hooks';
import { sqftValue, TakeoffBody, useTakeoff } from './RoofTakeoff';

/** The area form's limit on square feet. */
const MAX_SQFT = 200_000;

/** What Use puts into the area; `what` names the number in the confirmation ("roof deck"). */
export type RoofApply = { use: 'floor' | 'deck'; sqft: number; what: string; note: string } | { use: 'walls'; wallRunFt: number; note: string };

/** Whether the lookup is switched on on the server (asked only when it could be used). */
export function useRoofConfigured(ask: boolean): boolean {
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    // navigator.onLine too: the first render after a page opens offline still says online.
    if (!ask || !navigator.onLine) return;
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
      : `Measures ${street.trim()} from Google's aerial photo: attic floor, roof deck and wall run.`;
  return (
    <div className="space-y-1.5">
      <Button size="lg" block icon={Satellite} disabled={Boolean(reason)} onClick={onOpen}>
        Look up from the address
      </Button>
      <p className={cx('text-[15px] leading-snug', reason ? 'font-bold text-ink-2' : 'font-medium text-ink-2')}>{reason ?? hint}</p>
    </div>
  );
}

/** What Use would apply for this area, or why it can't yet. `parts` is the button's words around the number. */
function applyFor(result: RoofResult, f: RoofFigures, choices: RoofChoices, job: RoofJob, pick: RoofPick): { apply: RoofApply; parts: [string, string, string] } | { reason: string } {
  if (job === 'walls') {
    if (f.wallRunFt === null)
      return {
        reason: "No outline was found, so there's no wall run. Measure the walls on site.",
      };
    const ft = roundFt(f.wallRunFt);
    if (ft <= 0) return { reason: 'Nothing to use: turn on some roof faces.' };
    return {
      apply: {
        use: 'walls',
        wallRunFt: ft,
        note: noteLine(result, f, choices, job),
      },
      parts: ['Use', num(ft), 'ft as the wall run'],
    };
  }
  if (job === 'garage' && f.facesKept === 0 && !(offersUnmatched(result, job) && !choices.unmatchedOut)) return { reason: "Turn on the garage's roof faces." };
  const deck = job === 'attic' && pick === 'deck';
  if (deck && f.deckSqft === null) return { reason: 'Turn on at least one roof face for the roof deck.' };
  const sqft = roundSqft(deck ? f.deckSqft! : f.floorSqft);
  if (sqft <= 0) return { reason: 'Nothing to use: turn on some roof faces.' };
  if (sqft > MAX_SQFT) return { reason: 'Too big for one area. Measure it by hand.' };
  const what = deck ? PICK_WORDS.deck.note : JOB_WORDS[job].number.toLowerCase();
  return {
    apply: {
      use: deck ? 'deck' : 'floor',
      sqft,
      what,
      note: noteLine(result, f, choices, job, pick),
    },
    parts: ['Use', num(sqft), 'sq ft'],
  };
}

/** "Use 1,970 sq ft", the number in gauge numerals; one text run, so it is also the button's name. */
function UseLabel({ parts }: { parts: [string, string, string] }) {
  return (
    <span>
      {parts[0]} <span className="gauge-m text-[26px] leading-none">{parts[1]}</span> {parts[2]}
    </span>
  );
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function RoofLookupSheet({
  area,
  measurement,
  estimateId,
  address,
  onApply,
  onClose,
  onMeasure,
}: {
  area: AreaDraft;
  measurement: Measurement | undefined;
  estimateId: string;
  /** The address to look up (complete; see lookupAddress). */
  address: string;
  onApply: (a: RoofApply) => void;
  onClose: () => void;
  /**
   * "Measure by hand" after a failed lookup: open Measure for this area. Without it the button
   * closes the sheet, back to the area and its Measure button.
   */
  onMeasure?: () => void;
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
  const blocked = t.needsConfirm ? 'Check the house first: tap Right house.' : use && 'reason' in use ? use.reason : null;

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`Roof lookup for ${area.name}`}
      tabIndex={-1}
      onKeyDown={trapTab}
      className="fixed inset-0 z-50 m-0 flex flex-col overflow-y-auto overscroll-contain bg-canvas text-ink outline-none"
    >
      <div className="sticky top-0 z-10 border-b-[length:var(--bw-x)] border-solid border-rule bg-surface" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-2.5">
          <IconButton icon={X} label="Close" onClick={onClose} />
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-[22px] leading-tight font-extrabold tracking-[-0.01em]">
              <Icon icon={Satellite} />
              Roof lookup
            </h2>
            <p className="truncate text-[15px] font-semibold text-ink-2">{area.name}</p>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 pt-4 pb-6">
        <TakeoffBody
          t={t}
          mode="area"
          label={address}
          numbers={f ? <Numbers f={f} job={job} pick={pick} onPick={(p) => setAreaPick(area.id, p)} /> : null}
          steps={{ onMeasure: onMeasure ?? onClose }}
        />
      </div>

      {result && use && t.picking === 'off' ? (
        <Dock position="sticky" blocked={blocked} note={job === 'walls' ? 'Fills the wall run in Measure; you add the wall height.' : 'Fills Square feet and notes the source.'}>
          <Button variant="primary" size="lg" block disabled={Boolean(blocked) || !('apply' in use)} onClick={() => 'apply' in use && !blocked && onApply(use.apply)}>
            {'apply' in use ? <UseLabel parts={use.parts} /> : 'Use'}
          </Button>
        </Dock>
      ) : null}
    </div>
  );
}

/** Gauges this long (five digits and a comma) step down a size so they stay inside a phone's tile. */
const tileSize = (...values: string[]) => (values.some((v) => v.length >= 6) ? 'l' : 'xl');

/**
 * The number the area takes. An attic chooses between two readout tiles (the chosen one hi-vis);
 * a crawlspace, garage or wall run has one reading.
 */
function Numbers({ f, job, pick, onPick }: { f: RoofFigures; job: RoofJob; pick: RoofPick; onPick: (p: RoofPick) => void }) {
  if (job === 'attic') {
    const floor = sqftValue(f.floorSqft);
    const deck = sqftValue(f.deckSqft);
    return (
      <ReadoutTiles
        label="Which number to use"
        value={pick}
        onChange={onPick}
        size={tileSize(floor, deck)}
        compact
        options={[
          {
            value: 'floor',
            label: 'Attic floor',
            meaning: 'Blown-in, on the ceiling',
            gauge: floor,
            unit: 'square feet',
          },
          {
            value: 'deck',
            label: 'Roof deck',
            meaning: 'Spray foam, under the roof',
            gauge: deck,
            unit: f.deckSqft === null ? undefined : 'square feet',
          },
        ]}
      />
    );
  }
  const garageEmpty = job === 'garage' && f.facesKept === 0 && f.floorSqft === 0;
  const walls = job === 'walls';
  const value = walls ? (f.wallRunFt === null ? '—' : num(roundFt(f.wallRunFt))) : garageEmpty ? '—' : sqftValue(f.floorSqft);
  const hint: ReactNode =
    job === 'crawlspace'
      ? 'The house footprint inside the walls. Leave out the garage and porch.'
      : job === 'garage'
        ? garageEmpty
          ? "Turn on the garage's roof faces."
          : 'From the roof faces turned on below.'
        : 'Porch and garage walls count unless their faces are off.';
  return (
    <div data-readout className="plate flex min-w-0 flex-col items-start gap-2 p-4">
      <SignLabel tone="ink">{JOB_WORDS[job].number}</SignLabel>
      <span className={cx('text-[15px] leading-snug', garageEmpty ? 'font-bold text-warn' : 'font-semibold text-ink-2')}>{hint}</span>
      {walls && f.wallRunRough ? (
        <span className="flex items-center gap-1.5 text-[15px] font-bold text-warn">
          <Icon icon={TriangleAlert} size="xs" />
          Rough: from the building&apos;s size
        </span>
      ) : null}
      <span className="gauge mt-1 text-[56px] text-ink">{value}</span>
      {value === '—' ? null : <SignLabel tone="ink">{walls ? 'feet' : 'square feet'}</SignLabel>}
    </div>
  );
}

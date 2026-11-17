'use client';
// "Look up from the address": the satellite lookup for an area. The Roof Takeoff site finds the
// house on Google's aerial photo and measures the roof; this sheet shows the outline on the photo
// and the number the area needs (attic floor or roof deck, crawlspace floor, garage ceiling or wall
// run), with what to check on site right under it. The estimator sets the overhang, picks the roof
// faces that count, can tap the right roof when Google picked the wrong house, and uses the number.
// Nothing changes in the estimate until Use.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { AreaDraft } from '@/lib/sync/draft';
import type { Measurement } from '@/lib/measure/measure';
import {
  checkOnSite,
  DEFAULT_OVERHANG_IN,
  defaultFaces,
  faceGroup,
  facing,
  imageryText,
  JOB_WORDS,
  MAP_SIZE,
  mapFrame,
  mapZoom,
  noteLine,
  NOT_CONFIGURED_MESSAGE,
  offersUnmatched,
  OVERHANG_CHOICES,
  PICK_WORDS,
  pitchText,
  QUALITY_WORDS,
  roofFigures,
  roofJob,
  roundFt,
  roundSqft,
  SQFT_PER_M2,
  startPick,
  whenText,
  type LatLng,
  type RoofChoices,
  type RoofFigures,
  type RoofJob,
  type RoofPick,
  type RoofResult,
} from '@/lib/roof/lookup';
import {
  confirmHouse,
  roofLookupService,
  setAreaPick,
  setLookupFaces,
  setLookupOverhang,
  startRoofLookup,
  stopRoofLookup,
  useAreaPick,
  useHouseLookup,
} from '@/lib/offline/roofLookup';
import { Alert, Badge, Button, Card, Chips, cx, Field } from '@/components/ui';
import { useOnline } from '../hooks';

const comma = (n: number) => n.toLocaleString('en-US');
const OVERHANG_OPTIONS = OVERHANG_CHOICES.map((o) => ({ value: String(o), label: o ? `${o}"` : 'None' }));
/** The area form's limit on square feet. */
const MAX_SQFT = 200_000;

/** What Use puts into the area; `what` names the number in the confirmation ("roof deck"). */
export type RoofApply = { use: 'floor' | 'deck'; sqft: number; what: string; note: string } | { use: 'walls'; wallRunFt: number; note: string };

/** Whether the lookup can be used here, and the Roof Takeoff site's address (for its link). */
function useRoofService(ask: boolean): { configured: boolean; url: string | null } {
  const [s, setS] = useState<{ configured: boolean; url: string | null }>({ configured: true, url: null });
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void roofLookupService().then((r) => live && setS(r));
    return () => {
      live = false;
    };
  }, [ask]);
  return s;
}

/** The button under Measure on an area, with why it can't be used yet. */
export function RoofLookupButton({ estimateId, address, street, onOpen }: { estimateId: string; address: string | null; street: string; onOpen: () => void }) {
  const online = useOnline();
  const state = useHouseLookup(estimateId, address);
  // Ask the server whether the lookup is on only when it could be used (signal and an address).
  const { configured } = useRoofService(online && Boolean(address));
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
  const group = faceGroup(job);
  const words = JOB_WORDS[job];
  const state = useHouseLookup(estimateId, address);
  const chosen = useAreaPick(area.id);
  const pick: RoofPick = job === 'attic' ? (chosen ?? startPick(measurement)) : 'floor';
  const { url } = useRoofService(true);
  const last = state.last;
  const result = last?.result ?? null;
  const start = (o: { pin?: LatLng | null; fresh?: boolean } = {}) => startRoofLookup({ estimateId, areaId: area.id, address, pin: o.pin ?? null, fresh: o.fresh });
  const retry = () => start({ pin: state.failed?.pin ?? null, fresh: state.failed?.fresh ?? false });

  // Opening the sheet looks the house up, unless this visit already did (or is doing) it, on any
  // area, or it just failed (then the error shows with Try again, rather than paying again unasked).
  useEffect(() => {
    if (!state.running && !state.last && !state.error) start();
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

  const [elapsed, setElapsed] = useState(0);
  const startedAt = state.running?.startedAt ?? null;
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  // Wrong house: off, waiting for a tap on the photo, or a spot tapped and waiting for "Look up".
  // Kept for the result it was started on, so a new result ends it.
  const [pickFor, setPickFor] = useState<{ lookupId: string; at: 'tap' | LatLng } | null>(null);
  const picking: 'off' | 'tap' | LatLng = pickFor && last && pickFor.lookupId === last.lookupId ? pickFor.at : 'off';
  const setPicking = (at: 'off' | 'tap' | LatLng) => setPickFor(at === 'off' || !last ? null : { lookupId: last.lookupId, at });
  // After a tap, bring "Look up this roof instead?" into view (the photo can fill the screen).
  const pickPrompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof picking === 'object') pickPrompt.current?.scrollIntoView({ block: 'nearest' });
  }, [picking]);

  const faces = result ? (state.faces[group] ?? defaultFaces(result, group)) : null;
  const choices: RoofChoices | null = result && faces ? { overhangIn: state.overhangIn ?? DEFAULT_OVERHANG_IN, ...faces } : null;
  const f = result && choices ? roofFigures(result, choices) : null;
  const needsConfirm = Boolean(result && result.precision !== 'ROOFTOP' && !state.confirmed);
  const setFaces = (c: Partial<RoofChoices>) => choices && setLookupFaces(estimateId, address, group, { excluded: c.excluded ?? choices.excluded, unmatchedOut: c.unmatchedOut ?? choices.unmatchedOut });
  const toCheck = result && f ? checkOnSite(result, f, job, state.confirmed) : [];
  const use = result && f && choices ? applyFor(result, f, choices, job, pick) : null;
  const blocked = needsConfirm ? 'Check the house on the photo first: tap “Yes, this is the house”.' : use && 'reason' in use ? use.reason : null;

  // Announced to screen readers: the lookup's status only (not the seconds, not every number change).
  const status = state.running
    ? state.running.pin
      ? 'Looking up the roof you tapped.'
      : `Looking up ${address}.`
    : last
      ? `Found the roof${last.reused ? ': a saved lookup' : ''}.`
      : '';

  const lookUpAgain = (
    <Button variant="secondary" onClick={() => start({ pin: last?.pin ?? null, fresh: true })} disabled={Boolean(state.running)}>
      Look up again
    </Button>
  );

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`Satellite lookup for ${area.name}`}
      tabIndex={-1}
      onKeyDown={trapTab}
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-slate-100 outline-none"
    >
      <div className="sticky top-0 z-10 bg-white shadow-sm" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-2">
          <h2 className="truncate text-lg font-bold">🛰️ {area.name}</h2>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        {f ? <Numbers f={f} job={job} pick={pick} onPick={(p) => setAreaPick(area.id, p)} /> : null}
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-4">
        <p role="status" className="sr-only">
          {status}
        </p>

        {state.running ? (
          <Card className="space-y-3">
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-1 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
              <div className="min-w-0">
                <p className="font-semibold">{state.running.pin ? 'Looking up the roof you tapped' : `Looking up ${address}`}</p>
                <p className="text-sm text-slate-600">Finding the house on Google&apos;s aerial photo and measuring the roof. Usually 10–30 seconds.</p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span aria-hidden className="text-2xl font-extrabold tabular-nums text-slate-700">
                {elapsed}s
              </span>
              <Button variant="secondary" onClick={() => stopRoofLookup(estimateId, address)}>
                Stop
              </Button>
            </div>
          </Card>
        ) : null}
        {!state.running && state.error ? (
          <Card className="space-y-3">
            <div role="alert">
              <Alert tone="red">{state.error.message}</Alert>
            </div>
            <p className="text-xs text-slate-600">{state.failed?.pin ? 'Looked up: the roof you tapped on the photo' : `Looked up: ${address}`}</p>
            <Button className="w-full" onClick={retry}>
              Try again
            </Button>
          </Card>
        ) : null}
        {!state.running && !state.error && !result ? (
          <Card className="space-y-3">
            <p className="text-sm text-slate-700">Look up {address} on Google&apos;s aerial photo.</p>
            <Button className="w-full" onClick={() => start()}>
              Look up
            </Button>
          </Card>
        ) : null}

        {result && f && choices && last ? (
          <>
            {toCheck.length ? (
              <Card className="border-l-4 border-amber-400">
                <h3 className="font-semibold">Check on site</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {toCheck.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <div className="space-y-2">
              <SatelliteMap
                key={last.lookupId}
                result={result}
                excluded={choices.excluded}
                picking={picking}
                onTap={(p) => setPicking(p)}
              />
              {picking === 'tap' ? (
                <div className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 shadow-sm ring-1 ring-slate-200">
                  <p className="text-sm font-semibold text-slate-800">Tap the right roof on the photo.</p>
                  <Button variant="secondary" size="sm" onClick={() => setPicking('off')}>
                    Cancel
                  </Button>
                </div>
              ) : picking !== 'off' ? (
                <div ref={pickPrompt} className="space-y-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-800">Look up this roof instead?</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" onClick={() => setPicking('off')}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => {
                        const pin = picking;
                        setPicking('off');
                        start({ pin });
                      }}
                      disabled={Boolean(state.running)}
                    >
                      Look up
                    </Button>
                  </div>
                </div>
              ) : needsConfirm ? (
                <div className="space-y-2 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
                  <p className="text-sm text-amber-900">{result.precision === 'PIN' ? 'Is the yellow outline on the roof you tapped?' : 'Google placed this address roughly. Is the yellow outline on the right house?'}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button onClick={() => confirmHouse(estimateId, address)}>Yes, this is the house</Button>
                    <Button variant="secondary" onClick={() => setPicking('tap')} disabled={Boolean(state.running)}>
                      Wrong house? Tap the right roof
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {result.precision !== 'ROOFTOP' ? <p className="text-sm text-emerald-800">✓ You checked this is the house.</p> : <span />}
                  <Button variant="ghost" size="sm" onClick={() => setPicking('tap')} disabled={Boolean(state.running)}>
                    Wrong house? Tap the right roof
                  </Button>
                </div>
              )}
            </div>

            <Card className="space-y-2">
              <p className="font-semibold leading-snug">{result.address ?? 'The roof you tapped on the photo'}</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span>{imageryText(result) ? `Aerial photo from ${imageryText(result)}` : 'Aerial photo date unknown'}</span>
                {result.quality && QUALITY_WORDS[result.quality] ? <Badge tone={QUALITY_WORDS[result.quality]!.tone}>{QUALITY_WORDS[result.quality]!.label}</Badge> : null}
              </div>
              {last.reused ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-sm text-slate-700">Saved lookup from {whenText(new Date(last.lookedUpAt))}</p>
                  {lookUpAgain}
                </div>
              ) : null}
              <dl className="space-y-1 pt-1 text-sm">
                <Fact label="Main pitch" value={f.mainPitch !== null ? pitchText(f.mainPitch) : '—'} />
                <Fact label="Roof outline (to the drip edge)" value={`${comma(roundSqft(f.footprintSqft))} sq ft`} />
                <Fact label="Wall run" value={f.wallRunFt !== null ? `${comma(roundFt(f.wallRunFt))} ft${f.wallRunRough ? " (rough: from the building's size)" : ''}` : '—'} />
                <Fact label="Whole roof incl. overhangs" value={`${comma(roundSqft(f.wholeRoofSqft))} sq ft`} />
              </dl>
            </Card>

            <Card className="space-y-2">
              <Field label="Roof overhang" group hint="How far the eaves stick out past the walls. The numbers are measured inside them. Every area of this estimate uses it.">
                <Chips label="Roof overhang" value={String(choices.overhangIn)} onChange={(v) => setLookupOverhang(estimateId, address, Number(v))} options={OVERHANG_OPTIONS} />
              </Field>
            </Card>

            {result.segments.length ? (
              <Card>
                <h3 className="font-semibold">Roof faces</h3>
                <p className={cx('mt-1 text-xs', job === 'garage' && f.facesKept === 0 ? 'font-semibold text-amber-800' : 'text-slate-500')}>{words.facesHint}</p>
                <ul className="mt-2 divide-y divide-slate-100">
                  {result.segments.map((s) => {
                    const on = !choices.excluded.includes(s.n);
                    return (
                      <FaceRow
                        key={s.n}
                        badge={String(s.n)}
                        on={on}
                        title={`${pitchText(s.rise)} · ${facing(s.azimuthDeg, s.rise)}`}
                        detail={`${comma(roundSqft(s.areaM2 * SQFT_PER_M2))} sq ft of roof`}
                        hint={s.lower ? 'Lower roof: garage, porch or addition?' : null}
                        switchLabel={switchWord(job)}
                        ariaLabel={`Face ${s.n}: ${switchWord(job).toLowerCase()}`}
                        onToggle={() => setFaces({ excluded: on ? [...choices.excluded, s.n] : choices.excluded.filter((n) => n !== s.n) })}
                      />
                    );
                  })}
                  {offersUnmatched(result, job) ? (
                    <FaceRow
                      badge="?"
                      on={!choices.unmatchedOut}
                      title={`Parts with no roof data (${comma(roundSqft(f.unmatchedSqft))} sq ft)`}
                      detail="Outline Google has no roof faces for: a carport or a flat part?"
                      hint={null}
                      switchLabel={switchWord(job)}
                      ariaLabel={`Parts with no roof data: ${switchWord(job).toLowerCase()}`}
                      onToggle={() => setFaces({ unmatchedOut: !choices.unmatchedOut })}
                    />
                  ) : null}
                </ul>
              </Card>
            ) : null}

            <div className="flex flex-col items-stretch gap-2 pb-2">
              {last.reused ? null : lookUpAgain}
              {url ? (
                <div className="text-center">
                  <a
                    href={`${url}/?address=${encodeURIComponent(address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-12 items-center justify-center rounded-xl px-4 font-semibold text-brand-800 hover:bg-brand-50"
                  >
                    Open the Roof Takeoff site ↗
                  </a>
                  <p className="text-xs text-slate-500">A separate site with the roof edges for roofing. It fills in this address; it looks the house up again only if you press Look up there.</p>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {result && use && picking === 'off' ? (
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

const switchWord = (job: RoofJob) => (job === 'walls' ? 'Count its walls' : job === 'garage' ? 'Part of the garage' : `Over the ${JOB_WORDS[job].space}`);

function FaceRow({
  badge,
  on,
  title,
  detail,
  hint,
  switchLabel,
  ariaLabel,
  onToggle,
}: {
  badge: string;
  on: boolean;
  title: string;
  detail: string;
  hint: string | null;
  switchLabel: string;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold', on ? 'bg-slate-800 text-white' : 'bg-slate-200 text-slate-600')}>{badge}</span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="text-sm text-slate-600">{detail}</div>
        {hint ? <div className="text-xs font-medium text-amber-800">{hint}</div> : null}
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={ariaLabel} onClick={onToggle} className="flex min-h-11 w-16 shrink-0 flex-col items-center justify-center gap-1 px-1">
        <span className={cx('relative h-6 w-11 rounded-full transition-colors', on ? 'bg-brand-600' : 'bg-slate-300')}>
          <span className={cx('absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', on ? 'translate-x-5.5' : 'translate-x-0.5')} />
        </span>
        <span className="text-center text-[11px] leading-tight text-slate-600">{switchLabel}</span>
      </button>
    </li>
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3">
      <dt className="text-slate-600">{label}:</dt>
      <dd className="font-semibold tabular-nums text-slate-800">{value}</dd>
    </div>
  );
}

/**
 * Google's aerial photo with the roof outline, each face's number and the spot Google found. While
 * the estimator is picking the right roof, a tap anywhere on the photo marks that spot.
 */
function SatelliteMap({ result, excluded, picking, onTap }: { result: RoofResult; excluded: readonly number[]; picking: 'off' | 'tap' | LatLng; onTap: (p: LatLng) => void }) {
  const zoom = mapZoom(result.box);
  const view = useMemo(() => mapFrame(result.center, zoom), [result.center, zoom]);
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const src = `/api/roof/satellite?${new URLSearchParams({ lat: String(result.center.lat), lng: String(result.center.lng), zoom: String(zoom) })}`;
  const pts = (ring: RoofResult['outline'][number]) =>
    ring
      .map(view.toPx)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');
  const dot = view.toPx(result.point);
  const out = new Set(excluded);
  const marker = typeof picking === 'object' ? view.toPx(picking) : null;
  // Each face's number: in the middle of its shape, or at Google's middle of the face without one.
  const shaped = new Set(result.faces.map((f) => f.n));
  const labels = [
    ...result.faces.map((f) => ({ n: f.n, c: f.poly.map(view.toPx).reduce((a, p) => ({ x: a.x + p.x / f.poly.length, y: a.y + p.y / f.poly.length }), { x: 0, y: 0 }) })),
    ...result.segments.filter((s) => !shaped.has(s.n) && s.center).map((s) => ({ n: s.n, c: view.toPx(s.center!) })),
  ];
  const tap = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = ((e.clientX - box.left) / box.width) * MAP_SIZE;
    const y = ((e.clientY - box.top) / box.height) * MAP_SIZE;
    onTap(view.toLatLng(x, y));
  };
  return (
    <div className={cx('relative aspect-square w-full overflow-hidden rounded-2xl bg-slate-800 shadow-sm ring-1', picking === 'tap' ? 'ring-4 ring-brand-500' : 'ring-slate-200')}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in proxy image */}
      <img src={src} alt={`Aerial photo of ${result.address ?? 'the house'}`} width={640} height={640} className="absolute inset-0 h-full w-full" onLoad={() => setState('ok')} onError={() => setState('failed')} />
      {state !== 'ok' ? (
        <p className="absolute inset-x-0 bottom-3 text-center text-sm text-slate-200">{state === 'loading' ? 'Loading the aerial photo…' : "The aerial photo didn't load. The numbers are still good."}</p>
      ) : null}
      <svg viewBox="0 0 640 640" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {result.faces.map((face) => (
          <polygon
            key={`f${face.n}`}
            points={pts(face.poly)}
            fill={out.has(face.n) ? 'rgba(15,23,42,0.55)' : 'rgba(250,204,21,0.12)'}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={1.5}
            strokeDasharray={out.has(face.n) ? '5 4' : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {result.outline.map((ring, i) => (
          <polygon key={`o${i}`} points={pts(ring)} fill="none" stroke="#facc15" strokeWidth={3} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
        {labels.map(({ n, c }) => {
          const off = out.has(n);
          return (
            <g key={`n${n}`}>
              <circle cx={c.x} cy={c.y} r={15} fill={off ? '#e2e8f0' : '#0f172a'} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central" fontSize={18} fontWeight={700} fill={off ? '#475569' : '#fff'}>
                {n}
              </text>
            </g>
          );
        })}
        <circle cx={dot.x} cy={dot.y} r={9} fill="#ef4444" stroke="#fff" strokeWidth={3} vectorEffect="non-scaling-stroke" />
        {marker ? (
          <g>
            <circle cx={marker.x} cy={marker.y} r={22} fill="rgba(37,99,235,0.25)" stroke="#fff" strokeWidth={3} vectorEffect="non-scaling-stroke" />
            <circle cx={marker.x} cy={marker.y} r={8} fill="#2563eb" stroke="#fff" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          </g>
        ) : null}
      </svg>
      {picking !== 'off' ? (
        <button type="button" aria-label="Tap the right roof on the photo" onClick={tap} className="absolute inset-0 h-full w-full cursor-crosshair bg-transparent" data-testid="roof-photo-tap" />
      ) : null}
    </div>
  );
}

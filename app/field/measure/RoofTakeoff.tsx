'use client';
// The roof takeoff for one house, shared by the area sheet ("Look up from the address") and the
// Roof lookup page, in the Daymark field register. Top to bottom:
//
//   1. The lookup running (named steps and the seconds), or failed (what happened, two next steps).
//   2. The aerial photo with the outline, the roof edges on an ink casing and the face numbers,
//      a chip with the house check, a north arrow and a scale bar; the map key under it.
//   3. The house check, the first decision: "Right house" or "Tap the right roof".
//   4. The numbers (the sheet's readout tiles, or the page's), the source line under them
//      ("Aerial photo · Jun 2023 · Good photo") and what to check on site (hazard).
//   5. Pitch, roof outline and wall run; the overhang; the roof faces with their switches.
//   6. "More details" (closed): roofing squares and bundles, roof edges and materials.
//   7. Print or save PDF, Copy summary, Look up again.
//
// The sheet adds the readout tiles and the Use dock; the page adds its address box and "Start an
// estimate here". No number here is typed in: each comes from lib/roof (figures, roofing, draw).
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import {
  checkOnSite,
  DEFAULT_OVERHANG_IN,
  defaultFaces,
  faceGroup,
  facing,
  JOB_WORDS,
  MAP_SIZE,
  mapFrame,
  offersUnmatched,
  OVERHANG_CHOICES,
  pitchText,
  roofFigures,
  roundFt,
  roundSqft,
  SQFT_PER_M2,
  whenText,
  type LatLng,
  type RoofChoices,
  type RoofFigures,
  type RoofJob,
  type RoofResult,
} from '@/lib/roof/lookup';
import {
  clampWaste,
  DEFAULT_WASTE,
  EDGE_INFO,
  edgeFeet,
  EDGES_NOT_MEASURED,
  LOW_SLOPE_LABEL,
  NO_SHINGLES,
  oneDecimal,
  presentEdges,
  reportFileTitle,
  squaresLabel,
  summaryText,
  takeoffData,
  WASTE_CHOICES,
  type TakeoffData,
} from '@/lib/roof/roofing';
import { edgeColor, MAP_COLORS, MAP_LINES, mapShapes, satelliteUrl, svgPoints, type MapShapes } from '@/lib/roof/draw';
import { HOUSE_CHIP, houseState, photoQuality, scaleBar, sourceLine, type HouseState } from '@/lib/roof/photo';
import { confirmHouse, setLookupFaces, setLookupOverhang, setLookupWaste, startRoofLookup, stopRoofLookup, useHouseLookup, type HouseLookup, type RoofLookup } from '@/lib/offline/roofLookup';
import { feet, num } from '@/lib/format';
import {
  Button,
  Check,
  ChevronDown,
  ChipGroup,
  CircleCheck,
  Copy,
  cx,
  Field,
  Icon,
  LoadingSteps,
  MapPin,
  OctagonAlert,
  PencilLine,
  Printer,
  RefreshCw,
  Ruler,
  Satellite,
  SectionHead,
  Segmented,
  SignLabel,
  Switch,
  SwitchTrack,
  TriangleAlert,
  X,
  type StepState,
} from '@/components/daymark';
import { NumberInput } from '@/components/NumberInput';
import { Pointer } from './roofIcons';
import { RoofReport } from './RoofReport';

const OVERHANG_OPTIONS = OVERHANG_CHOICES.map((o) => ({
  value: String(o),
  label: o ? `${o}"` : 'None',
}));
const WASTE_OPTIONS = WASTE_CHOICES.map((w) => ({
  value: String(w.pct),
  label: w.label,
}));

/** Square feet as the takeoff shows them: rounded to ten ("1,970"); a dash when there is none. */
export const sqftValue = (n: number | null | undefined) => (n === null || n === undefined ? '—' : num(roundSqft(n)));

/** Wrong house: off, waiting for a tap on the photo, or a spot tapped and waiting for "Look up". */
export type Picking = 'off' | 'tap' | LatLng;

export interface Takeoff {
  estimateId: string | null;
  areaId: string | null;
  /** The address this house is looked up by (the store's key). */
  address: string;
  job: RoofJob;
  state: HouseLookup;
  last: RoofLookup | null;
  result: RoofResult | null;
  /** The choices for this area's faces (a garage has its own). */
  choices: RoofChoices | null;
  f: RoofFigures | null;
  /** The house's choices, for the report and the summary (whatever the area). */
  houseChoices: RoofChoices | null;
  wastePct: number;
  data: TakeoffData | null;
  needsConfirm: boolean;
  picking: Picking;
  setPicking: (p: Picking) => void;
  start: (o?: { pin?: LatLng | null; fresh?: boolean }) => void;
  setFaces: (c: Partial<Pick<RoofChoices, 'excluded' | 'unmatchedOut'>>) => void;
}

/**
 * One house's lookup and the numbers from it, for an area (job) or the Roof lookup page ('attic').
 * `near` names the house on paper when a roof was tapped on the photo (default: the address).
 */
export function useTakeoff({ estimateId, areaId, address, job, near = address }: { estimateId: string | null; areaId: string | null; address: string; job: RoofJob; near?: string | null }): Takeoff {
  const group = faceGroup(job);
  const state = useHouseLookup(estimateId, address);
  const last = state.last;
  const result = last?.result ?? null;
  const overhangIn = state.overhangIn ?? DEFAULT_OVERHANG_IN;
  // Kept stable while nothing changes, so the report's photo is painted again only when it should be.
  const savedFaces = state.faces[group];
  const choices: RoofChoices | null = useMemo(() => (result ? { overhangIn, ...(savedFaces ?? defaultFaces(result, group)) } : null), [result, overhangIn, savedFaces, group]);
  const f = useMemo(() => (result && choices ? roofFigures(result, choices) : null), [result, choices]);
  const savedHouse = state.faces.house;
  const houseChoices: RoofChoices | null = useMemo(() => (result ? { overhangIn, ...(savedHouse ?? defaultFaces(result, 'house')) } : null), [result, overhangIn, savedHouse]);
  const wastePct = state.wastePct ?? DEFAULT_WASTE;
  const confirmed = state.confirmed;
  const data = useMemo(() => {
    if (!result || !houseChoices || !last) return null;
    // The report's "Check on site" is the house's: what the attic sheet says, house faces and all, in its words for paper.
    const warnings = checkOnSite(result, roofFigures(result, houseChoices), 'attic', confirmed, true);
    return takeoffData(result, houseChoices, wastePct, new Date(last.lookedUpAt), { warnings, near });
  }, [result, houseChoices, wastePct, last, confirmed, near]);
  // Kept for the result it was started on, so a new result ends it.
  const [pickFor, setPickFor] = useState<{
    lookupId: string;
    at: 'tap' | LatLng;
  } | null>(null);
  const picking: Picking = pickFor && last && pickFor.lookupId === last.lookupId ? pickFor.at : 'off';
  return {
    estimateId,
    areaId,
    address,
    job,
    state,
    last,
    result,
    choices,
    f,
    houseChoices,
    wastePct,
    data,
    needsConfirm: Boolean(result && result.precision !== 'ROOFTOP' && !state.confirmed),
    picking,
    setPicking: (at) => setPickFor(at === 'off' || !last ? null : { lookupId: last.lookupId, at }),
    start: (o = {}) =>
      startRoofLookup({
        estimateId,
        areaId,
        address,
        pin: o.pin ?? null,
        fresh: o.fresh,
      }),
    setFaces: (c) =>
      choices &&
      setLookupFaces(estimateId, address, group, {
        excluded: c.excluded ?? choices.excluded,
        unmatchedOut: c.unmatchedOut ?? choices.unmatchedOut,
      }),
  };
}

/** What screen readers hear about the lookup: its status only (not the seconds, not every number change). */
export function statusText(t: Takeoff, label: string): string {
  if (t.state.running) return t.state.running.pin ? 'Looking up the roof you tapped.' : `Looking up ${label}.`;
  return t.last ? `Found the roof${t.last.reused ? ': a saved lookup' : ''}.` : '';
}

/** The next steps a failed lookup offers besides Try again (each screen has its own). */
export interface FailedSteps {
  /** The area sheet: measure the area by hand instead. */
  onMeasure?: () => void;
  /** The page: put the cursor back in the address box. */
  onEditAddress?: () => void;
}

/**
 * Everything about the house: the lookup running or failed, the photo and the house check, the
 * numbers (`numbers`, from the sheet or the page), what to check on site, the overhang and faces,
 * More details, Print and Copy, and the print report. `layout="split"` puts the photo beside the
 * rest on wide screens (the page on a desktop).
 */
export function TakeoffBody({
  t,
  mode,
  label,
  numbers,
  layout = 'column',
  steps = {},
}: {
  t: Takeoff;
  mode: 'area' | 'page';
  label: string;
  numbers?: ReactNode;
  layout?: 'column' | 'split';
  steps?: FailedSteps;
}) {
  const { state, last, result, choices, f, job } = t;
  // After a tap, bring "Look up this roof instead?" into view (the photo can fill the screen).
  const pickPrompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof t.picking === 'object') pickPrompt.current?.scrollIntoView({ block: 'nearest' });
  }, [t.picking]);
  const [showEdges, setShowEdges] = useState(true);
  const wide = useWide(layout === 'split');

  // The house check above says when Google placed the address roughly; this list is the rest.
  const toCheck = result && f ? checkOnSite(result, f, job, true) : [];
  const lookUpAgain = (
    <Button icon={RefreshCw} onClick={() => t.start({ pin: last?.pin ?? null, fresh: true })} disabled={Boolean(state.running)}>
      Look up again
    </Button>
  );

  return (
    <>
      <p role="status" className="sr-only">
        {statusText(t, label)}
      </p>

      {state.running ? <LookupProgress t={t} label={label} /> : null}
      {!state.running && state.error ? <LookupError t={t} label={label} steps={steps} /> : null}
      {mode === 'area' && !state.running && !state.error && !result ? (
        <div className="plate space-y-3 p-4">
          <p className="text-[17px] font-semibold text-ink">Look up {label} on Google&apos;s aerial photo.</p>
          <Button variant="primary" size="lg" block icon={Satellite} onClick={() => t.start()}>
            Look up
          </Button>
        </div>
      ) : null}

      {result && f && choices && last ? (
        <Arranged
          wide={wide}
          photo={<PhotoPlate key={last.lookupId} t={t} result={result} excluded={choices.excluded} showEdges={showEdges} />}
          house={<HouseCheck t={t} pickPrompt={pickPrompt} />}
          mapKey={<MapKeyPlate t={t} result={result} excluded={choices.excluded} showEdges={showEdges} setShowEdges={setShowEdges} />}
          numbers={
            <>
              {numbers ? <div className="space-y-3">{numbers}</div> : null}
              <SourceLine result={result} last={last} lookUpAgain={lookUpAgain} />
              <CheckOnSite items={job === 'attic' ? [ATTIC_ROOMS, ...toCheck] : toCheck} />
            </>
          }
          rest={
            <>
              <RoofFacts f={f} />
              <section aria-labelledby="roof-overhang-head" className="space-y-2.5">
                <SectionHead as="h3" id="roof-overhang-head">
                  Roof overhang
                </SectionHead>
                <Segmented label="Roof overhang" value={String(choices.overhangIn)} onChange={(v) => setLookupOverhang(t.estimateId, t.address, Number(v))} options={OVERHANG_OPTIONS} />
                <p className="text-[15px] leading-snug font-medium text-ink-2">
                  How far the eaves stick out past the walls. The numbers are measured inside them.
                  {mode === 'area' ? ' Every area of this estimate uses it.' : ''}
                </p>
              </section>
              {result.segments.length ? <FacesCard t={t} /> : null}
              {t.data ? <MoreDetails t={t} data={t.data} startOpen={mode === 'page'} /> : null}
              {t.data ? <ShareButtons data={t.data} /> : null}
              {last.reused ? null : <div className="flex flex-col items-stretch pb-2">{lookUpAgain}</div>}
            </>
          }
        />
      ) : null}
      {result && last && t.data && t.houseChoices ? <RoofReport data={t.data} result={result} excluded={t.houseChoices.excluded} /> : null}
    </>
  );
}

const noSubscribe = () => () => undefined;
const WIDE = '(min-width: 1024px)';
/** True on a desktop-wide screen (1024px and up), where the page puts the photo beside the numbers. */
function useWide(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? subscribeWide : noSubscribe,
    () => enabled && window.matchMedia(WIDE).matches,
    () => false,
  );
}
function subscribeWide(cb: () => void) {
  const q = window.matchMedia(WIDE);
  q.addEventListener('change', cb);
  return () => q.removeEventListener('change', cb);
}

/**
 * The takeoff's parts in order. The house check is the first decision, so it always sits where
 * the photo is first seen. On a phone (and in the sheet): the photo, the house check right under
 * it, the numbers, the map key, then the rest. Wide: the photo and the map key in a column that
 * stays in view, beside the house check, the numbers and the rest.
 */
function Arranged({ wide, photo, house, mapKey, numbers, rest }: { wide: boolean; photo: ReactNode; house: ReactNode; mapKey: ReactNode; numbers: ReactNode; rest: ReactNode }) {
  if (wide) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-8">
        <div className="sticky top-4 space-y-3">
          {photo}
          {mapKey}
        </div>
        <div className="space-y-5">
          {house}
          {numbers}
          {rest}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {photo}
        {house}
      </div>
      {numbers}
      {mapKey}
      {rest}
    </div>
  );
}

/** What the satellite numbers never include: said with the attic numbers, as a hazard. */
const ATTIC_ROOMS = 'Finished attic rooms, cathedral ceilings and knee walls are not in these numbers. Measure them on site.';

// ---------------------------------------------------------------------------------------------
// Running and failed
// ---------------------------------------------------------------------------------------------

/** The lookup running: named steps and the seconds so far (never a bare spinner), and Stop. */
function LookupProgress({ t, label }: { t: Takeoff; label: string }) {
  const running = t.state.running!;
  const [elapsed, setElapsed] = useState(0);
  const startedAt = running.startedAt;
  useEffect(() => {
    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  // The request is one call: it has been sent; finding and measuring is what the wait is for.
  const steps: Array<{ label: string; state: StepState }> = [
    {
      label: running.pin ? 'Sent the spot you tapped' : 'Sent the address',
      state: 'done',
    },
    { label: 'Finding the house and measuring the roof', state: 'doing' },
    { label: 'Drawing the outline and edges on the photo', state: 'todo' },
  ];
  return (
    <div className="plate space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <SignLabel>Roof lookup</SignLabel>
          <p className="text-[20px] leading-snug font-extrabold text-ink">{running.pin ? 'Looking up the roof you tapped' : `Looking up ${label}`}</p>
        </div>
        <span aria-hidden className="flex shrink-0 flex-col items-end gap-1">
          <span className="gauge text-[44px] text-ink">{elapsed}s</span>
        </span>
      </div>
      {/* A scan line over a dark photo plate while the photo is on its way (still, with reduced motion). */}
      <div aria-hidden className="relative h-24 overflow-hidden rounded-control bg-frame">
        <span className="absolute inset-0 animate-[dm-shimmer_2.2s_linear_infinite] bg-[linear-gradient(90deg,transparent_46%,var(--on-frame)_50%,transparent_54%)] bg-[length:300%_100%] opacity-70" />
        <span className="absolute inset-0 flex items-center justify-center text-on-frame">
          <Icon icon={Satellite} size="l" />
        </span>
      </div>
      <LoadingSteps steps={steps} />
      <p className="text-[15px] font-medium text-ink-2">Usually 10 to 30 seconds.</p>
      <Button block icon={X} onClick={() => stopRoofLookup(t.estimateId, t.address)}>
        Stop
      </Button>
    </div>
  );
}

/**
 * The lookup failed: what happened in words, what was looked up, and two next steps: Try again,
 * and the way round it (tap the right roof on the last photo, measure by hand, or edit the address).
 * Not found is not fixed by trying again, so then the way round is the main step.
 */
function LookupError({ t, label, steps }: { t: Takeoff; label: string; steps: FailedSteps }) {
  const { state } = t;
  const error = state.error!;
  const retry = () =>
    t.start({
      pin: state.failed?.pin ?? null,
      fresh: state.failed?.fresh ?? false,
    });
  const notFound = error.code === 'not_found';
  const other: ReactNode =
    state.failed?.pin && t.result ? (
      <Button variant={notFound ? 'primary' : 'secondary'} icon={Pointer} onClick={() => t.setPicking('tap')}>
        Tap the right roof
      </Button>
    ) : steps.onEditAddress ? (
      <Button variant={notFound ? 'primary' : 'secondary'} icon={PencilLine} onClick={steps.onEditAddress}>
        Edit address
      </Button>
    ) : steps.onMeasure ? (
      <Button variant={notFound ? 'primary' : 'secondary'} icon={Ruler} onClick={steps.onMeasure}>
        Measure by hand
      </Button>
    ) : null;
  return (
    <div className="space-y-3 rounded-plate border-[length:var(--bw)] border-solid border-bad bg-bad-fill p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-bad">
          <Icon icon={OctagonAlert} />
        </span>
        <div className="min-w-0 space-y-1">
          <p role="alert" className="text-[17px] leading-snug font-bold text-ink">
            {error.message}
          </p>
          <p className="text-[15px] font-medium text-ink-2">{state.failed?.pin ? 'Looked up: the roof you tapped on the photo' : `Looked up: ${label}`}</p>
        </div>
      </div>
      <div className={cx('grid gap-3', other && 'sm:grid-cols-2')}>
        {other}
        <Button variant={other && notFound ? 'secondary' : 'primary'} icon={RefreshCw} onClick={retry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The photo and the house check
// ---------------------------------------------------------------------------------------------

/** The photo plate: the aerial photo with the house-check chip, north arrow and scale bar. */
function PhotoPlate({ t, result, excluded, showEdges }: { t: Takeoff; result: RoofResult; excluded: readonly number[]; showEdges: boolean }) {
  const house = houseState(result, t.state.confirmed, t.picking !== 'off');
  return (
    <div className="plate overflow-hidden">
      <SatelliteMap result={result} excluded={excluded} showEdges={showEdges} picking={t.picking} house={house} onTap={(p) => t.setPicking(p)} />
    </div>
  );
}

/** The map key: what each line on the photo is, with its feet; and Show roof edges. */
function MapKeyPlate({ t, result, excluded, showEdges, setShowEdges }: { t: Takeoff; result: RoofResult; excluded: readonly number[]; showEdges: boolean; setShowEdges: (v: boolean) => void }) {
  const edges = Boolean(t.data?.edgesMeasured);
  return (
    <section aria-labelledby="map-key-head" className="plate overflow-hidden">
      <div className="flex min-h-14 items-center justify-between gap-3 px-3.5 py-1">
        <h3 id="map-key-head" className="sign-label text-ink">
          Map key
        </h3>
        {edges ? (
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="text-[15px] font-bold text-ink-2">
              Show roof edges
            </span>
            <Switch checked={showEdges} onChange={setShowEdges} label="Show roof edges" />
          </span>
        ) : null}
      </div>
      <MapLegend result={result} excluded={excluded} showEdges={showEdges} />
    </section>
  );
}

/** The house's address as Google matched it, or the roof tapped on the photo. */
function HouseAddress({ result }: { result: RoofResult }) {
  return (
    <p className="flex items-start gap-2 text-[17px] leading-snug font-bold text-ink">
      <Icon icon={MapPin} size="s" className="mt-0.5 text-ink-2" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{result.address ?? 'The roof you tapped on the photo'}</span>
    </p>
  );
}

/**
 * The house check, the first decision under the photo: "Right house" (the one thing to do next,
 * so hi-vis) or "Tap the right roof"; then, picking, the tap and "Look up this roof instead?".
 */
function HouseCheck({ t, pickPrompt }: { t: Takeoff; pickPrompt: RefObject<HTMLDivElement | null> }) {
  const { result, picking, state } = t;
  if (!result) return null;
  if (picking === 'tap') {
    return (
      <div className="plate flex items-center justify-between gap-3 p-3.5">
        <p className="flex items-center gap-2 text-[17px] font-bold text-ink">
          <Icon icon={Pointer} />
          Tap the right roof on the photo.
        </p>
        <Button size="sm" onClick={() => t.setPicking('off')}>
          Cancel
        </Button>
      </div>
    );
  }
  if (picking !== 'off') {
    return (
      <div ref={pickPrompt} className="plate space-y-3 p-4">
        <p className="text-[18px] font-extrabold text-ink">Look up this roof instead?</p>
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => t.setPicking('off')}>Cancel</Button>
          <Button
            variant="primary"
            icon={Satellite}
            onClick={() => {
              const pin = picking;
              t.setPicking('off');
              t.start({ pin });
            }}
            disabled={Boolean(state.running)}
          >
            Look up
          </Button>
        </div>
      </div>
    );
  }
  if (t.needsConfirm) {
    const pin = result.precision === 'PIN';
    return (
      <section aria-labelledby="house-check-head" className="plate space-y-3 p-4">
        <h3 id="house-check-head" className="text-[20px] leading-snug font-extrabold text-ink">
          {pin ? 'Is the white outline on the roof you tapped?' : 'Is this the right house?'}
        </h3>
        {pin ? null : <p className="text-[16px] leading-snug font-medium text-ink-2">Google placed this address roughly, so the white outline may be on a neighbour&apos;s house.</p>}
        <HouseAddress result={result} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Button variant="primary" block icon={CircleCheck} onClick={() => confirmHouse(t.estimateId, t.address)}>
            Right house
          </Button>
          <Button block icon={Pointer} onClick={() => t.setPicking('tap')} disabled={Boolean(state.running)}>
            Tap the right roof
          </Button>
        </div>
      </section>
    );
  }
  return (
    <div className="space-y-1.5 px-1">
      <HouseAddress result={result} />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 text-[15px] font-bold text-ok">
          <Icon icon={CircleCheck} size="s" />
          {result.precision === 'ROOFTOP' ? 'Google matched the house itself.' : 'You checked this is the house.'}
        </p>
        <Button variant="ghost" size="sm" icon={Pointer} onClick={() => t.setPicking('tap')} disabled={Boolean(state.running)}>
          Wrong house? Tap the right roof
        </Button>
      </div>
    </div>
  );
}

/** The chip in the photo's corner: where the house check stands. */
function HouseChip({ house }: { house: HouseState }) {
  const icon = house === 'tap' ? Pointer : house === 'check' ? TriangleAlert : CircleCheck;
  return (
    <span className="pointer-events-none absolute top-2.5 left-2.5 z-[2] inline-flex h-10 items-center gap-1.5 rounded-[10px] border-2 border-solid border-frame bg-on-frame pr-3 pl-2 text-[15px] font-extrabold text-frame">
      <Icon icon={icon} size="s" />
      {HOUSE_CHIP[house]}
    </span>
  );
}

/** North is always up on Google's photos. */
function NorthArrow() {
  return (
    <span
      role="img"
      aria-label="North is up"
      className="pointer-events-none absolute top-2.5 right-2.5 z-[2] flex h-11 w-11 flex-col items-center justify-center rounded-full border-2 border-solid border-frame bg-on-frame text-frame"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
        <path d="M8 1 L13.5 14 L8 11 L2.5 14 Z" fill="currentColor" />
      </svg>
      <span className="gauge-m -mt-0.5 text-[11px] leading-none">N</span>
    </span>
  );
}

/** The scale bar: a round length in feet, as long as that is on the photo shown. */
function ScaleBarChip({ result, magnify }: { result: RoofResult; magnify: number }) {
  const bar = scaleBar(result, magnify);
  if (!bar) return null;
  const style: CSSProperties = {
    width: `${bar.share * 100}%`,
    boxSizing: 'content-box',
  };
  return (
    <span
      role="img"
      aria-label={`Scale: the bar is ${feet(bar.feet)}`}
      className="pointer-events-none absolute bottom-2.5 left-2.5 z-[2] flex flex-col gap-1 rounded-[8px] border-2 border-solid border-frame bg-on-frame px-2 pt-1 pb-1.5 text-frame"
      style={style}
    >
      <span className="gauge-m text-[14px]">{feet(bar.feet)}</span>
      <span className="block h-1.5 w-full border-2 border-t-0 border-solid border-frame bg-[linear-gradient(90deg,var(--frame)_50%,transparent_50%)]" />
    </span>
  );
}

/** A line swatch for the map key: the colour on its ink casing (dashed for a pitch break). */
function Swatch({ color, dash, thin }: { color: string; dash?: boolean; thin?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block w-6 shrink-0 rounded-full', thin ? 'h-1.5' : 'h-2.5')}
      style={{
        background: dash ? `repeating-linear-gradient(90deg, ${color} 0 5px, ${MAP_COLORS.casing} 5px 8px)` : color,
        boxShadow: `0 0 0 2px ${MAP_COLORS.casing}`,
      }}
    />
  );
}

/** The legend under the photo: the outline, each edge type on this roof with its feet, and the shading. */
function MapLegend({ result, excluded, showEdges }: { result: RoofResult; excluded: readonly number[]; showEdges: boolean }) {
  const ft = edgeFeet(result);
  const data = showEdges
    ? presentEdges(ft).map((k) => ({
        type: k,
        label: EDGE_INFO[k].label,
        ft: ft[k],
      }))
    : [];
  const shaded = result.faces.some((f) => excluded.includes(f.n));
  const items: ReactNode[] = [];
  if (result.outline.length)
    items.push(
      <li key="outline" className="flex items-center gap-2">
        <Swatch color={MAP_COLORS.light} thin />
        Roof outline
      </li>,
    );
  for (const e of data)
    items.push(
      <li key={e.type} className="flex items-center gap-2">
        <Swatch color={edgeColor(e.type)} dash={Boolean(EDGE_INFO[e.type].dash)} />
        <span>
          {e.label} <b className="gauge-m text-[17px] text-ink">{feet(roundFt(e.ft))}</b>
        </span>
      </li>,
    );
  if (shaded)
    items.push(
      <li key="out" className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-3.5 w-6 shrink-0 rounded-[3px]"
          style={{
            background: `repeating-linear-gradient(-45deg, ${MAP_COLORS.light} 0 3px, ${MAP_COLORS.casing} 3px 5px)`,
            boxShadow: `0 0 0 2px ${MAP_COLORS.casing}`,
          }}
        />
        Left out
      </li>,
    );
  if (!items.length) return null;
  return (
    <ul aria-label="Map key" className="grid grid-cols-2 gap-x-3 gap-y-2.5 border-t-[length:var(--bw)] border-solid border-edge px-3.5 py-3 text-[15px] font-semibold text-ink-2 sm:grid-cols-3">
      {items}
    </ul>
  );
}

/**
 * Google's aerial photo with the roof outline, the roof edges in their colours on an ink casing,
 * each face's number and the spot Google found; the house-check chip, north arrow and scale bar
 * on top. While the estimator is picking the right roof, a tap anywhere on the photo marks that spot.
 */
function SatelliteMap({
  result,
  excluded,
  showEdges,
  picking,
  house,
  onTap,
}: {
  result: RoofResult;
  excluded: readonly number[];
  showEdges: boolean;
  picking: Picking;
  house: HouseState;
  onTap: (p: LatLng) => void;
}) {
  const shapes: MapShapes = useMemo(() => mapShapes(result, excluded), [result, excluded]);
  const view = useMemo(() => mapFrame(result.center, shapes.zoom), [result.center, shapes.zoom]);
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const hatch = `hatch-${useId().replace(/:/g, '')}`;
  const marker = typeof picking === 'object' ? view.toPx(picking) : null;
  const tap = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = ((e.clientX - box.left) / box.width) * MAP_SIZE;
    const y = ((e.clientY - box.top) / box.height) * MAP_SIZE;
    onTap(view.toLatLng(x, y));
  };
  // A small roof is shown enlarged; while the estimator picks the right roof, the whole photo shows.
  const k = picking === 'off' ? shapes.magnify : 1;
  const C = MAP_COLORS;
  const L = MAP_LINES;
  const numbers: CSSProperties = {
    fontFamily: 'var(--f-num)',
    fontStretch: '85%',
  };
  return (
    // A little shorter than square (the top and bottom of the photo are only lawn and road), so the
    // house check fits under it on a phone's first screen; picking the right roof shows it whole.
    <div className={cx('relative z-[1] w-full overflow-hidden bg-frame', picking === 'off' ? 'aspect-[6/5]' : 'aspect-square')}>
      <div className="absolute inset-x-0 top-1/2 aspect-square -translate-y-1/2">
        <div className="absolute inset-0" style={{ transform: `scale(${k})` }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in proxy image */}
          <img
            src={satelliteUrl(result)}
            alt={`Aerial photo of ${result.address ?? 'the house'} with the roof outline${showEdges ? ', the roof edges' : ''} and the numbered roof faces`}
            width={640}
            height={640}
            className="absolute inset-0 h-full w-full"
            onLoad={() => setState('ok')}
            onError={() => setState('failed')}
          />
          <svg viewBox="0 0 640 640" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <defs>
              <pattern id={hatch} patternUnits="userSpaceOnUse" width={11 / k} height={11 / k} patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2={11 / k} stroke={C.hatch} strokeWidth={2.5 / k} />
              </pattern>
            </defs>
            {shapes.faces.map((face) =>
              face.out ? (
                <g key={`f${face.n}`}>
                  <polygon points={svgPoints(face.pts)} fill={C.leftOut} />
                  <polygon points={svgPoints(face.pts)} fill={`url(#${hatch})`} />
                </g>
              ) : (
                <polygon
                  key={`f${face.n}`}
                  points={svgPoints(face.pts)}
                  fill="rgba(255,255,255,0.06)"
                  stroke={showEdges ? 'none' : 'rgba(255,255,255,0.6)'}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ),
            )}
            {shapes.outline.map((ring, i) => (
              <g key={`o${i}`}>
                <polygon points={svgPoints(ring)} fill="none" stroke={C.casing} strokeWidth={L.outline + L.casing} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                <polygon points={svgPoints(ring)} fill="none" stroke={C.light} strokeWidth={L.outline} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </g>
            ))}
            {showEdges
              ? shapes.edges.map((e, i) => (
                  <g key={`e${i}`} data-edge={e.type}>
                    <polyline points={svgPoints(e.pts)} fill="none" stroke={C.casing} strokeWidth={L.edge + L.casing} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                    <polyline
                      points={svgPoints(e.pts)}
                      fill="none"
                      stroke={edgeColor(e.type)}
                      strokeWidth={L.edge}
                      strokeDasharray={EDGE_INFO[e.type].dash?.join(' ')}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ))
              : null}
            {shapes.labels.map(({ n, at, out }) => (
              <g key={`n${n}`}>
                <circle cx={at.x} cy={at.y} r={20 / k} fill={out ? C.light : C.casing} stroke={out ? C.casing : C.light} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
                <text x={at.x} y={at.y} textAnchor="middle" dominantBaseline="central" fontSize={23 / k} fontWeight={800} fill={out ? C.casing : C.light} style={numbers}>
                  {n}
                </text>
              </g>
            ))}
            <circle cx={shapes.point.x} cy={shapes.point.y} r={11 / k} fill="none" stroke={C.casing} strokeWidth={5} vectorEffect="non-scaling-stroke" />
            <circle cx={shapes.point.x} cy={shapes.point.y} r={11 / k} fill="none" stroke={C.light} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
            {marker ? (
              <g>
                <circle cx={marker.x} cy={marker.y} r={22} fill="none" stroke="var(--hivis-edge)" strokeWidth={8} vectorEffect="non-scaling-stroke" />
                <circle cx={marker.x} cy={marker.y} r={22} fill="none" stroke="var(--hivis)" strokeWidth={4} vectorEffect="non-scaling-stroke" />
                <circle cx={marker.x} cy={marker.y} r={8} fill="var(--hivis)" stroke="var(--hivis-edge)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
              </g>
            ) : null}
          </svg>
          {picking !== 'off' ? (
            <button type="button" aria-label="Tap the right roof on the photo" onClick={tap} className="absolute inset-0 h-full w-full cursor-crosshair bg-transparent" data-testid="roof-photo-tap" />
          ) : null}
        </div>
      </div>
      {/* Picking the right roof: the photo is the thing being chosen, so it gets the hi-vis ring (with its ink edge). */}
      {picking === 'tap' ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[2]"
          style={{
            boxShadow: 'inset 0 0 0 2px var(--hivis-edge), inset 0 0 0 6px var(--hivis), inset 0 0 0 8px var(--hivis-edge)',
          }}
        />
      ) : null}
      <HouseChip house={house} />
      <NorthArrow />
      <ScaleBarChip result={result} magnify={k} />
      {state !== 'ok' ? (
        <p className="pointer-events-none absolute inset-x-4 top-1/2 z-[2] -translate-y-1/2 text-center text-[16px] font-bold text-on-frame">
          {state === 'loading' ? 'Loading the aerial photo…' : "The aerial photo didn't load. The numbers are still good."}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Under the numbers
// ---------------------------------------------------------------------------------------------

/** Where the numbers come from: "Aerial photo · Jun 2023 · Good photo", and a saved lookup's time. */
function SourceLine({ result, last, lookUpAgain }: { result: RoofResult; last: RoofLookup; lookUpAgain: ReactNode }) {
  const quality = photoQuality(result);
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold text-ink-2">
        <Icon icon={Satellite} size="s" />
        <span>{sourceLine(result)}</span>
        {quality ? (
          <>
            <span aria-hidden>·</span>
            <span className={cx('inline-flex items-center gap-1', quality.tone === 'warn' && 'font-bold text-warn')}>
              {quality.tone === 'warn' ? <Icon icon={TriangleAlert} size="xs" /> : null}
              <span>{quality.label}</span>
            </span>
          </>
        ) : null}
      </p>
      {last.reused ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-sunken px-3.5 py-2.5">
          <p className="text-[15px] font-semibold text-ink-2">Saved lookup from {whenText(new Date(last.lookedUpAt))}</p>
          {lookUpAgain}
        </div>
      ) : null}
    </div>
  );
}

/** What to check on site: a hazard, so the hatch with an icon and a word. */
function CheckOnSite({ items }: { items: readonly string[] }) {
  const id = useId();
  if (!items.length) return null;
  return (
    <section aria-labelledby={id} className="relative overflow-hidden rounded-control border-[length:var(--bw)] border-solid border-edge bg-warn-fill py-3 pr-3.5 pl-7">
      <span aria-hidden className="hatch absolute inset-y-0 left-0 w-2.5" />
      <h3 id={id} className="flex items-center gap-2 text-[17px] font-extrabold text-warn">
        <Icon icon={TriangleAlert} size="s" />
        Check on site
      </h3>
      <ul className="mt-1.5 list-disc space-y-1.5 pl-5 text-[15.5px] leading-snug font-semibold text-ink">
        {items.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </section>
  );
}

/** Pitch, roof outline and wall run: three gauges in one plate. */
function RoofFacts({ f }: { f: RoofFigures }) {
  const cell = 'flex min-w-0 flex-col gap-1.5 px-2.5 py-3';
  const unit = 'font-text text-[14px] font-extrabold [font-stretch:100%]';
  return (
    <dl aria-label="Roof facts" className="plate grid grid-cols-[1fr_1.3fr_1fr] divide-x-[length:var(--bw)] divide-solid divide-edge">
      <div className={cell}>
        <dt className="sign-label whitespace-nowrap text-ink-2 [--sign-size:11px]">Pitch</dt>
        <dd className="gauge text-[28px] text-ink">{f.mainPitch !== null ? pitchText(f.mainPitch) : '—'}</dd>
      </div>
      <div className={cell}>
        <dt className="sign-label whitespace-nowrap text-ink-2 [--sign-size:11px]">Roof outline</dt>
        <dd className="gauge text-[28px] text-ink">
          {sqftValue(f.footprintSqft)} <span className={unit}>sq ft</span>
        </dd>
      </div>
      <div className={cell}>
        <dt className="sign-label whitespace-nowrap text-ink-2 [--sign-size:11px]">Wall run</dt>
        <dd className="gauge text-[28px] text-ink">
          {f.wallRunFt !== null ? num(roundFt(f.wallRunFt)) : '—'}
          {f.wallRunFt !== null ? (
            <>
              {' '}
              <span className={unit}>ft</span>
            </>
          ) : null}
          {f.wallRunFt !== null && f.wallRunRough ? <span className="mt-1 block font-text text-[14px] font-bold text-warn [font-stretch:100%]">rough</span> : null}
        </dd>
      </div>
    </dl>
  );
}

const switchWord = (job: RoofJob) => (job === 'walls' ? 'Count its walls' : job === 'garage' ? 'Part of the garage' : `Over the ${JOB_WORDS[job].space}`);

/** The roof faces: each one a 72px row that is one big switch, and what they add up to. */
function FacesCard({ t }: { t: Takeoff }) {
  const { result, f, choices, job } = t;
  if (!result || !f || !choices) return null;
  const total = result.segments.length;
  const sum = job === 'walls' ? (f.wallRunFt !== null ? feet(roundFt(f.wallRunFt)) : '—') : job === 'garage' && f.facesKept === 0 && f.floorSqft === 0 ? '—' : `${sqftValue(f.floorSqft)} sq ft`;
  return (
    <section aria-labelledby="roof-faces-head" className="space-y-2.5">
      <SectionHead as="h3" id="roof-faces-head" count={`${f.facesKept} of ${total}`}>
        Roof faces
      </SectionHead>
      <p className={cx('text-[15px] leading-snug', job === 'garage' && f.facesKept === 0 ? 'font-bold text-warn' : 'font-medium text-ink-2')}>{JOB_WORDS[job].facesHint}</p>
      <ul className="plate divide-y divide-solid divide-line overflow-hidden">
        {result.segments.map((s) => {
          const on = !choices.excluded.includes(s.n);
          return (
            <FaceRow
              key={s.n}
              badge={String(s.n)}
              on={on}
              title={
                <>
                  <span className="gauge-m text-[21px]">{pitchText(s.rise)}</span> {facing(s.azimuthDeg, s.rise)}
                </>
              }
              detail={`${sqftValue(s.areaM2 * SQFT_PER_M2)} sq ft of roof`}
              hints={[s.lowSlope ? 'Low slope: not for shingles' : null, s.lower ? 'Lower roof: garage, porch or addition?' : null].filter((h): h is string => Boolean(h))}
              ariaLabel={`Face ${s.n}: ${switchWord(job).toLowerCase()}`}
              onToggle={() =>
                t.setFaces({
                  excluded: on ? [...choices.excluded, s.n] : choices.excluded.filter((n) => n !== s.n),
                })
              }
            />
          );
        })}
        {offersUnmatched(result, job) ? (
          <FaceRow
            badge="?"
            on={!choices.unmatchedOut}
            title={`Parts with no roof data (${sqftValue(f.unmatchedSqft)} sq ft)`}
            detail="Outline Google has no roof faces for: a carport or a flat part?"
            hints={[]}
            ariaLabel={`Parts with no roof data: ${switchWord(job).toLowerCase()}`}
            onToggle={() => t.setFaces({ unmatchedOut: !choices.unmatchedOut })}
          />
        ) : null}
        <li className="flex items-center justify-between gap-3 bg-sunken px-4 py-3">
          <SignLabel tone="ink-2" size={11.5}>
            {JOB_WORDS[job].number} · {f.facesKept === 1 ? '1 face' : `${f.facesKept} faces`}
          </SignLabel>
          <span className="gauge-m text-[24px] whitespace-nowrap text-ink">{sum}</span>
        </li>
      </ul>
    </section>
  );
}

function FaceRow({
  badge,
  on,
  title,
  detail,
  hints,
  ariaLabel,
  onToggle,
}: {
  badge: string;
  on: boolean;
  title: ReactNode;
  detail: string;
  hints: readonly string[];
  ariaLabel: string;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <li>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={ariaLabel}
        aria-describedby={id}
        onClick={onToggle}
        className="flex min-h-[72px] w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-sunken focus-visible:-outline-offset-4"
      >
        <span
          aria-hidden
          className={cx('gauge-m flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[16px]', on ? 'bg-ink text-on-ink' : 'bg-surface text-ink shadow-[inset_0_0_0_2px_var(--ink)]')}
        >
          {badge}
        </span>
        <span id={id} className="min-w-0 flex-1">
          <span className={cx('block text-[17px] leading-tight font-extrabold', on ? 'text-ink' : 'text-ink-3')}>{title}</span>
          <span className={cx('block text-[15px] font-semibold', on ? 'text-ink-2' : 'text-ink-3')}>{detail}</span>
          {hints.map((h) => (
            <span key={h} className="mt-1 flex items-start gap-1.5 text-[15px] leading-snug font-bold text-warn">
              <Icon icon={TriangleAlert} size="xs" className="mt-0.5" />
              <span>{h}</span>
            </span>
          ))}
        </span>
        <SwitchTrack on={on} />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// More details: roofing, edges and materials
// ---------------------------------------------------------------------------------------------

/**
 * Roofing squares and bundles, roof edges and materials: for roofing crews, not the insulation
 * number, so they sit closed under "More details". Not a <section>: each part inside is one.
 */
function MoreDetails({ t, data, startOpen }: { t: Takeoff; data: TakeoffData; startOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="plate overflow-hidden">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="flex min-h-16 w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-sunken"
        >
          <span className="min-w-0">
            <span className="block text-[18px] font-extrabold text-ink">More details</span>
            <span className="block text-[15px] font-semibold text-ink-2">Roofing squares and bundles, roof edges and materials</span>
          </span>
          <Icon icon={ChevronDown} className={cx('text-ink-2 transition-transform duration-[var(--t-quick)]', open && 'rotate-180')} />
        </button>
      </h3>
      {open ? (
        <div id={id} className="space-y-3 border-t border-solid border-line bg-sunken p-3">
          <RoofingSection t={t} data={data} startOpen={startOpen} />
          <EdgesSection data={data} startOpen={startOpen} />
        </div>
      ) : null}
    </div>
  );
}

/** A plate that opens and closes; the line under the title says what is inside while it is closed. */
export function Section({ title, summary, startOpen, children }: { title: string; summary: string; startOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  return (
    <section className="plate overflow-hidden">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="flex min-h-16 w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-sunken"
        >
          <span className="min-w-0">
            <span className="block text-[17px] font-extrabold text-ink">{title}</span>
            {open ? null : <span className="block truncate text-[15px] font-semibold text-ink-2">{summary}</span>}
          </span>
          <Icon icon={ChevronDown} className={cx('shrink-0 text-ink-2 transition-transform duration-[var(--t-quick)]', open && 'rotate-180')} />
        </button>
      </h3>
      {open ? (
        <div id={id} className="space-y-3 border-t border-solid border-line px-4 pt-3 pb-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** A small reading: a label, a gauge number with its unit, and a line under it. */
export function Tile({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-control bg-sunken px-3 py-2.5">
      <div className="text-[15px] leading-snug font-bold text-ink-2">{label}</div>
      {/* The unit wraps under a long number on a narrow phone instead of running out of the tile. */}
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-ink">
        <span className="gauge text-[32px]">{value}</span>
        {unit ? <span className="text-[15px] font-extrabold">{unit}</span> : null}
      </div>
      {sub ? <div className="text-[15px] leading-snug font-medium text-ink-3">{sub}</div> : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3">
      <dt className="text-ink-2">{label}:</dt>
      <dd className="gauge-m text-[18px] text-ink">{value}</dd>
    </div>
  );
}

/** Roof surface, squares, waste and the order, as the Roof Takeoff page worked them out. */
function RoofingSection({ t, data, startOpen }: { t: Takeoff; data: TakeoffData; startOpen: boolean }) {
  const chip = WASTE_CHOICES.some((w) => w.pct === data.wastePct) ? String(data.wastePct) : null;
  const lowSlope = data.lowSlopeSqft > 0 ? `${LOW_SLOPE_LABEL}: ${sqftValue(data.lowSlopeSqft)} sq ft. Membrane or rolled roofing.` : null;
  const summary =
    data.roofSqft === null
      ? 'No roof faces found'
      : !data.order
        ? `${sqftValue(data.roofSqft)} sq ft · no shingle area`
        : `${sqftValue(data.roofSqft)} sq ft · ${oneDecimal(data.squares!)} squares · order ${data.order.text} squares`;
  const pitch = (
    <dl className="text-[15px] font-semibold">
      <Fact label="Main pitch" value={data.mainPitch !== null ? pitchText(data.mainPitch) : '—'} />
    </dl>
  );
  return (
    <Section title="Roofing" summary={summary} startOpen={startOpen}>
      {data.roofSqft === null ? (
        <p className="text-[15px] font-medium text-ink-2">Google has no roof faces for this house, so there is no roof surface to order for.</p>
      ) : !data.order ? (
        <>
          <Tile label="Roof surface" value={sqftValue(data.roofSqft)} unit="sq ft" sub="Every face, along the slope" />
          <p className="text-[15px] font-medium text-ink-2">{NO_SHINGLES} Every face is under 2/12: membrane or rolled roofing, not shingles.</p>
          {pitch}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Roof surface" value={sqftValue(data.roofSqft)} unit="sq ft" sub="Every face, along the slope" />
            <Tile label={squaresLabel(data)} value={oneDecimal(data.squares!)} sub="1 square = 100 sq ft" />
            <Tile label={`Order with ${data.wastePct}% waste`} value={data.order.text} unit="squares" />
            <Tile label="Bundles" value={num(data.order.bundles)} sub="3 per square, rounded up" />
          </div>
          {lowSlope ? (
            <p className="flex items-start gap-1.5 text-[15px] font-bold text-warn">
              <Icon icon={TriangleAlert} size="xs" className="mt-0.5" />
              <span>{lowSlope}</span>
            </p>
          ) : null}
          <Field label="Waste" group hint="Gable roofs waste less; hips and cut-up roofs more.">
            <ChipGroup label="Waste" value={chip} onChange={(v) => setLookupWaste(t.estimateId, t.address, Number(v))} options={WASTE_OPTIONS} />
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[15px] font-semibold text-ink-2">Or type it (0 to 50):</span>
              <span className="w-24">
                <NumberInput aria-label="Waste percent" className="text-right" value={data.wastePct} onValue={(v) => v !== null && setLookupWaste(t.estimateId, t.address, clampWaste(v))} />
              </span>
              <span className="text-[15px] font-semibold text-ink-2">%</span>
            </div>
          </Field>
          {pitch}
        </>
      )}
    </Section>
  );
}

/** Feet of each edge type along the slope, and the materials they come to. */
function EdgesSection({ data, startOpen }: { data: TakeoffData; startOpen: boolean }) {
  const summary = data.edgesMeasured ? data.materials.map((m) => `${m.item.replace(/ \(.*\)$/, '')} ${num(m.ft)} ft`).join(' · ') : 'Not measured for this house';
  const row = 'flex items-center gap-3 py-2.5';
  return (
    <Section title="Roof edges and materials" summary={summary} startOpen={startOpen}>
      {!data.edgesMeasured ? (
        <p className="text-[15px] font-medium text-ink-2">{EDGES_NOT_MEASURED}</p>
      ) : (
        <>
          <div>
            <h4 className="sign-label text-ink-2 [--sign-size:11.5px]">Roof edges</h4>
            <ul className="mt-1 divide-y divide-solid divide-line">
              {data.edges.map((e) => (
                <li key={e.type} className={row}>
                  <span className="flex w-9 shrink-0 justify-center rounded-[6px] bg-frame py-2">
                    <Swatch color={edgeColor(e.type)} dash={Boolean(EDGE_INFO[e.type].dash)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-bold text-ink">{e.label}</span>
                    <span className="block text-[15px] font-medium text-ink-2">{EDGE_INFO[e.type].what}</span>
                  </span>
                  <span className="gauge-m text-[20px] whitespace-nowrap text-ink">{feet(roundFt(e.ft))}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[15px] font-medium text-ink-3">Feet along the slope.</p>
          </div>
          <div>
            <h4 className="sign-label text-ink-2 [--sign-size:11.5px]">Materials</h4>
            <ul className="mt-1 divide-y divide-solid divide-line">
              {data.materials.map((m) => (
                <li key={m.item} className={row}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-bold text-ink">{m.item}</span>
                    <span className="block text-[15px] font-medium text-ink-2">{m.from}</span>
                  </span>
                  <span className="gauge-m text-[20px] whitespace-nowrap text-ink">{feet(m.ft)}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="relative flex gap-2.5 pl-4 text-[15px] leading-snug font-semibold text-ink">
            <span aria-hidden className="hatch absolute inset-y-0 left-0 w-1.5 rounded-sm" />
            <span className="mt-px text-warn">
              <Icon icon={TriangleAlert} size="s" />
            </span>
            <span>Estimates from aerial data, rounded up to the next foot. Check on site before ordering.</span>
          </p>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Print and copy
// ---------------------------------------------------------------------------------------------

/** Copies text, with a fallback for browsers that don't allow the clipboard here. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

let titleBeforePrint: string | null = null;
/** Prints the report with the house as the page title, so a saved PDF is named after it; the title comes back after. */
function printReport(data: TakeoffData) {
  titleBeforePrint ??= document.title;
  document.title = reportFileTitle(data);
  const restore = () => {
    if (titleBeforePrint !== null) document.title = titleBeforePrint;
    titleBeforePrint = null;
  };
  window.addEventListener('afterprint', restore, { once: true });
  window.print();
}

function ShareButtons({ data }: { data: TakeoffData }) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-2">
      <div className="grid gap-3">
        <Button icon={Printer} onClick={() => printReport(data)}>
          Print or save PDF
        </Button>
        <Button
          icon={Copy}
          onClick={async () =>
            setMessage(
              (await copyText(summaryText(data)))
                ? {
                    ok: true,
                    text: 'Summary copied. Paste it into a note, text or email.',
                  }
                : {
                    ok: false,
                    text: "Couldn't copy here. Use Print or save PDF instead.",
                  },
            )
          }
        >
          Copy summary
        </Button>
      </div>
      <p aria-live="polite" className={cx('flex min-h-6 items-center justify-center gap-1.5 text-center text-[15px] font-semibold', message?.ok === false ? 'text-bad' : 'text-ink-2')}>
        {message?.ok ? (
          <span className="text-ok">
            <Icon icon={Check} size="s" />
          </span>
        ) : null}
        {message?.text}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The dock
// ---------------------------------------------------------------------------------------------

/**
 * The thumb dock for a takeoff screen: a 3px rule on top, a one-line note above the 64px action
 * (what it does, with a tick), or the reason it can't be used yet (with a warning sign). The sheet
 * keeps it at the bottom of its own scroll (sticky); the page fixes it above the tab bar.
 */
export function TakeoffDock({ fixed = false, note, blocked, children }: { fixed?: boolean; note?: ReactNode; blocked?: ReactNode; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label="Actions"
      className={cx('z-30 border-t-[length:var(--bw-x)] border-solid border-rule bg-surface px-4 pt-3', fixed ? 'shell-dock' : 'sticky bottom-0')}
      style={fixed ? undefined : { paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto max-w-2xl">
        {blocked ? (
          <p className="mb-2.5 flex items-start gap-2 text-[15.5px] leading-snug font-bold text-warn">
            <Icon icon={TriangleAlert} size="s" className="mt-0.5" />
            <span>{blocked}</span>
          </p>
        ) : note ? (
          <p className="mb-2.5 flex items-start gap-2 text-[15.5px] leading-snug font-semibold text-ink-2">
            <span className="mt-0.5 text-ok">
              <Icon icon={Check} size="s" />
            </span>
            <span>{note}</span>
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

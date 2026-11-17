'use client';
// The roof takeoff for one house, shared by the area sheet ("Look up from the address") and the
// Roof lookup page: the lookup running or failed, what to check on site, Google's aerial photo with
// the outline, the roof edges in their colours and the face numbers, the wrong-house tap and the
// house check, the overhang and the roof faces, the roofing numbers (squares, waste, the order in
// bundles), the roof edges and the materials they come to, and Print or Copy summary. The area
// sheet adds the number its area takes and the Use button; the page adds its address box.
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
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
  offersUnmatched,
  OVERHANG_CHOICES,
  pitchText,
  QUALITY_WORDS,
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
  oneDecimal,
  OUTLINE_COLOR,
  presentEdges,
  summaryText,
  takeoffData,
  WASTE_CHOICES,
  type TakeoffData,
} from '@/lib/roof/roofing';
import { mapShapes, satelliteUrl, svgPoints, type MapShapes } from '@/lib/roof/draw';
import {
  confirmHouse,
  setLookupFaces,
  setLookupOverhang,
  setLookupWaste,
  startRoofLookup,
  stopRoofLookup,
  useHouseLookup,
  type HouseLookup,
  type RoofLookup,
} from '@/lib/offline/roofLookup';
import { Alert, Badge, Button, Card, Chips, cx, Field, Toggle } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import { RoofReport } from './RoofReport';

export const comma = (n: number) => n.toLocaleString('en-US');
const OVERHANG_OPTIONS = OVERHANG_CHOICES.map((o) => ({ value: String(o), label: o ? `${o}"` : 'None' }));
const WASTE_OPTIONS = WASTE_CHOICES.map((w) => ({ value: String(w.pct), label: w.label }));

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

/** One house's lookup and the numbers from it, for an area (job) or the Roof lookup page ('attic'). */
export function useTakeoff({ estimateId, areaId, address, job }: { estimateId: string | null; areaId: string | null; address: string; job: RoofJob }): Takeoff {
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
    // The report's "Check on site" is the house's: what the attic sheet says, house faces and all.
    const warnings = checkOnSite(result, roofFigures(result, houseChoices), 'attic', confirmed);
    return takeoffData(result, houseChoices, wastePct, new Date(last.lookedUpAt), warnings);
  }, [result, houseChoices, wastePct, last, confirmed]);
  // Kept for the result it was started on, so a new result ends it.
  const [pickFor, setPickFor] = useState<{ lookupId: string; at: 'tap' | LatLng } | null>(null);
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
    start: (o = {}) => startRoofLookup({ estimateId, areaId, address, pin: o.pin ?? null, fresh: o.fresh }),
    setFaces: (c) =>
      choices &&
      setLookupFaces(estimateId, address, group, { excluded: c.excluded ?? choices.excluded, unmatchedOut: c.unmatchedOut ?? choices.unmatchedOut }),
  };
}

/** What screen readers hear about the lookup: its status only (not the seconds, not every number change). */
export function statusText(t: Takeoff, label: string): string {
  if (t.state.running) return t.state.running.pin ? 'Looking up the roof you tapped.' : `Looking up ${label}.`;
  return t.last ? `Found the roof${t.last.reused ? ': a saved lookup' : ''}.` : '';
}

/**
 * Everything under the numbers: the lookup running or failed, check on site, the photo, the
 * overhang and faces, roofing, edges and materials, Print and Copy summary, and the print report.
 */
export function TakeoffBody({ t, mode, label }: { t: Takeoff; mode: 'area' | 'page'; label: string }) {
  const { state, last, result, choices, f, job } = t;
  const [elapsed, setElapsed] = useState(0);
  const startedAt = state.running?.startedAt ?? null;
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  // After a tap, bring "Look up this roof instead?" into view (the photo can fill the screen).
  const pickPrompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof t.picking === 'object') pickPrompt.current?.scrollIntoView({ block: 'nearest' });
  }, [t.picking]);
  const [showEdges, setShowEdges] = useState(true);

  const toCheck = result && f ? checkOnSite(result, f, job, state.confirmed) : [];
  const retry = () => t.start({ pin: state.failed?.pin ?? null, fresh: state.failed?.fresh ?? false });
  const lookUpAgain = (
    <Button variant="secondary" onClick={() => t.start({ pin: last?.pin ?? null, fresh: true })} disabled={Boolean(state.running)}>
      Look up again
    </Button>
  );

  return (
    <>
      <p role="status" className="sr-only">
        {statusText(t, label)}
      </p>

      {state.running ? (
        <Card className="space-y-3">
          <div className="flex items-start gap-3">
            <span aria-hidden className="mt-1 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <div className="min-w-0">
              <p className="font-semibold">{state.running.pin ? 'Looking up the roof you tapped' : `Looking up ${label}`}</p>
              <p className="text-sm text-slate-600">Finding the house on Google&apos;s aerial photo and measuring the roof. Usually 10–30 seconds.</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span aria-hidden className="text-2xl font-extrabold tabular-nums text-slate-700">
              {elapsed}s
            </span>
            <Button variant="secondary" onClick={() => stopRoofLookup(t.estimateId, t.address)}>
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
          <p className="text-xs text-slate-600">{state.failed?.pin ? 'Looked up: the roof you tapped on the photo' : `Looked up: ${label}`}</p>
          <Button className="w-full" onClick={retry}>
            Try again
          </Button>
        </Card>
      ) : null}
      {mode === 'area' && !state.running && !state.error && !result ? (
        <Card className="space-y-3">
          <p className="text-sm text-slate-700">Look up {label} on Google&apos;s aerial photo.</p>
          <Button className="w-full" onClick={() => t.start()}>
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
            <div>
              <SatelliteMap key={last.lookupId} result={result} excluded={choices.excluded} showEdges={showEdges} picking={t.picking} onTap={(p) => t.setPicking(p)} />
              <MapLegend result={result} excluded={choices.excluded} showEdges={showEdges} />
            </div>
            {t.data?.edgesMeasured ? <Toggle checked={showEdges} onChange={setShowEdges} label="Show roof edges" /> : null}
            <HouseCheck t={t} pickPrompt={pickPrompt} />
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
              {mode === 'page' ? <Fact label="Roof deck over the attic floor" value={f.deckSqft !== null ? `${comma(roundSqft(f.deckSqft))} sq ft` : '—'} /> : null}
              <Fact label="Main pitch" value={f.mainPitch !== null ? pitchText(f.mainPitch) : '—'} />
              <Fact label="Roof outline (to the drip edge)" value={`${comma(roundSqft(f.footprintSqft))} sq ft`} />
              <Fact label="Wall run" value={f.wallRunFt !== null ? `${comma(roundFt(f.wallRunFt))} ft${f.wallRunRough ? " (rough: from the building's size)" : ''}` : '—'} />
            </dl>
          </Card>

          <Card className="space-y-2">
            <Field label="Roof overhang" group hint={`How far the eaves stick out past the walls. The numbers are measured inside them.${mode === 'area' ? ' Every area of this estimate uses it.' : ''}`}>
              <Chips label="Roof overhang" value={String(choices.overhangIn)} onChange={(v) => setLookupOverhang(t.estimateId, t.address, Number(v))} options={OVERHANG_OPTIONS} />
            </Field>
          </Card>

          {result.segments.length ? <FacesCard t={t} /> : null}

          {t.data ? <RoofingSection t={t} data={t.data} startOpen={mode === 'page'} /> : null}
          {t.data ? <EdgesSection data={t.data} startOpen={mode === 'page'} /> : null}
          {t.data ? <ShareButtons data={t.data} /> : null}

          {last.reused ? null : <div className="flex flex-col items-stretch pb-2">{lookUpAgain}</div>}

          {t.data && t.houseChoices ? <RoofReport data={t.data} result={result} excluded={t.houseChoices.excluded} /> : null}
        </>
      ) : null}
    </>
  );
}

/** The house check under the photo: confirm the house, or tap the right roof and look it up. */
function HouseCheck({ t, pickPrompt }: { t: Takeoff; pickPrompt: RefObject<HTMLDivElement | null> }) {
  const { result, picking, state } = t;
  if (!result) return null;
  if (picking === 'tap') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 shadow-sm ring-1 ring-slate-200">
        <p className="text-sm font-semibold text-slate-800">Tap the right roof on the photo.</p>
        <Button variant="secondary" size="sm" onClick={() => t.setPicking('off')}>
          Cancel
        </Button>
      </div>
    );
  }
  if (picking !== 'off') {
    return (
      <div ref={pickPrompt} className="space-y-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <p className="font-semibold text-slate-800">Look up this roof instead?</p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => t.setPicking('off')}>
            Cancel
          </Button>
          <Button
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
    return (
      <div className="space-y-2 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
        <p className="text-sm text-amber-900">{result.precision === 'PIN' ? 'Is the white outline on the roof you tapped?' : 'Google placed this address roughly. Is the white outline on the right house?'}</p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => confirmHouse(t.estimateId, t.address)}>Yes, this is the house</Button>
          <Button variant="secondary" onClick={() => t.setPicking('tap')} disabled={Boolean(state.running)}>
            Wrong house? Tap the right roof
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {result.precision !== 'ROOFTOP' ? <p className="text-sm text-emerald-800">✓ You checked this is the house.</p> : <span />}
      <Button variant="ghost" size="sm" onClick={() => t.setPicking('tap')} disabled={Boolean(state.running)}>
        Wrong house? Tap the right roof
      </Button>
    </div>
  );
}

const switchWord = (job: RoofJob) => (job === 'walls' ? 'Count its walls' : job === 'garage' ? 'Part of the garage' : `Over the ${JOB_WORDS[job].space}`);

function FacesCard({ t }: { t: Takeoff }) {
  const { result, f, choices, job } = t;
  if (!result || !f || !choices) return null;
  return (
    <Card>
      <h3 className="font-semibold">Roof faces</h3>
      <p className={cx('mt-1 text-xs', job === 'garage' && f.facesKept === 0 ? 'font-semibold text-amber-800' : 'text-slate-500')}>{JOB_WORDS[job].facesHint}</p>
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
              onToggle={() => t.setFaces({ excluded: on ? [...choices.excluded, s.n] : choices.excluded.filter((n) => n !== s.n) })}
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
            onToggle={() => t.setFaces({ unmatchedOut: !choices.unmatchedOut })}
          />
        ) : null}
      </ul>
    </Card>
  );
}

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

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3">
      <dt className="text-slate-600">{label}:</dt>
      <dd className="font-semibold tabular-nums text-slate-800">{value}</dd>
    </div>
  );
}

/** A card that opens and closes; the line under the title says what is inside while it is closed. */
export function Section({ title, summary, startOpen, children }: { title: string; summary: string; startOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  return (
    <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left">
          <span className="min-w-0">
            <span className="block font-semibold">{title}</span>
            {open ? null : <span className="block truncate text-sm font-normal text-slate-600">{summary}</span>}
          </span>
          <span aria-hidden className={cx('shrink-0 text-lg text-slate-500', open && 'rotate-180')}>
            ▾
          </span>
        </button>
      </h3>
      {open ? (
        <div id={id} className="space-y-3 border-t border-slate-100 px-4 pb-4 pt-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function Tile({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-xs font-semibold text-slate-600">{label}</div>
      <div className="whitespace-nowrap text-2xl font-extrabold tabular-nums text-slate-900">
        {value}
        {unit ? <span className="text-sm font-semibold"> {unit}</span> : null}
      </div>
      {sub ? <div className="text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

/** Roof surface, squares, waste and the order, as the Roof Takeoff page worked them out. */
function RoofingSection({ t, data, startOpen }: { t: Takeoff; data: TakeoffData; startOpen: boolean }) {
  const chip = WASTE_CHOICES.some((w) => w.pct === data.wastePct) ? String(data.wastePct) : null;
  const summary =
    data.roofSqft === null || !data.order
      ? 'No roof faces found'
      : `${comma(roundSqft(data.roofSqft))} sq ft · ${oneDecimal(data.squares!)} squares · order ${data.order.text} squares`;
  return (
    <Section title="Roofing" summary={summary} startOpen={startOpen}>
      {data.roofSqft === null || !data.order ? (
        <p className="text-sm text-slate-600">Google has no roof faces for this house, so there is no roof surface to order for.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Roof surface" value={comma(roundSqft(data.roofSqft))} unit="sq ft" sub="Every face, along the slope" />
            <Tile label="Squares" value={oneDecimal(data.squares!)} sub="1 square = 100 sq ft" />
            <Tile label={`Order with ${data.wastePct}% waste`} value={data.order.text} unit="squares" />
            <Tile label="Bundles" value={comma(data.order.bundles)} sub="3 per square, rounded up" />
          </div>
          <Field label="Waste" group hint="Gable roofs waste less; hips and cut-up roofs more.">
            <Chips label="Waste" value={chip} onChange={(v) => setLookupWaste(t.estimateId, t.address, Number(v))} options={WASTE_OPTIONS} />
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm text-slate-700">Or type it (0 to 50):</span>
              <span className="w-20">
                <NumberInput aria-label="Waste percent" className="text-right" value={data.wastePct} onValue={(v) => v !== null && setLookupWaste(t.estimateId, t.address, clampWaste(v))} />
              </span>
              <span className="text-sm text-slate-700">%</span>
            </div>
          </Field>
          <dl className="text-sm">
            <Fact label="Main pitch" value={data.mainPitch !== null ? pitchText(data.mainPitch) : '—'} />
          </dl>
        </>
      )}
    </Section>
  );
}

function Swatch({ color, dash }: { color: string; dash?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-5 shrink-0 rounded-full ring-1 ring-black/40"
      style={dash ? { background: `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 8px)`, backgroundColor: '#334155' } : { background: color }}
    />
  );
}

/** Feet of each edge type along the slope, and the materials they come to. */
function EdgesSection({ data, startOpen }: { data: TakeoffData; startOpen: boolean }) {
  const summary = data.edgesMeasured ? data.materials.map((m) => `${m.item.replace(/ \(.*\)$/, '')} ${comma(m.ft)} ft`).join(' · ') : 'Not measured for this house';
  return (
    <Section title="Roof edges and materials" summary={summary} startOpen={startOpen}>
      {!data.edgesMeasured ? (
        <p className="text-sm text-slate-600">{EDGES_NOT_MEASURED}</p>
      ) : (
        <>
          <div>
            <h4 className="text-sm font-semibold text-slate-700">Roof edges</h4>
            <ul className="mt-1 divide-y divide-slate-100">
              {data.edges.map((e) => (
                <li key={e.type} className="flex items-center gap-3 py-2">
                  <span className="flex w-6 justify-center rounded bg-slate-700 py-1.5">
                    <Swatch color={EDGE_INFO[e.type].color} dash={Boolean(EDGE_INFO[e.type].dash)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{e.label}</span>
                    <span className="block text-xs text-slate-600">{EDGE_INFO[e.type].what}</span>
                  </span>
                  <span className="whitespace-nowrap font-semibold tabular-nums">{comma(roundFt(e.ft))} ft</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-500">Feet along the slope.</p>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-slate-700">Materials</h4>
            <ul className="mt-1 divide-y divide-slate-100">
              {data.materials.map((m) => (
                <li key={m.item} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{m.item}</span>
                    <span className="block text-xs text-slate-600">{m.from}</span>
                  </span>
                  <span className="whitespace-nowrap font-semibold tabular-nums">{comma(m.ft)} ft</span>
                </li>
              ))}
            </ul>
          </div>
          <Alert tone="amber">Estimates from aerial data, rounded up to the next foot. Check on site before ordering.</Alert>
        </>
      )}
    </Section>
  );
}

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

function ShareButtons({ data }: { data: TakeoffData }) {
  const [message, setMessage] = useState('');
  return (
    <div className="space-y-1">
      <div className="grid gap-2">
        <Button variant="secondary" onClick={() => window.print()}>
          🖨️ Print or save PDF
        </Button>
        <Button
          variant="secondary"
          onClick={async () => setMessage((await copyText(summaryText(data))) ? 'Summary copied. Paste it into a note, text or email.' : "Couldn't copy here. Use Print or save PDF instead.")}
        >
          📋 Copy summary
        </Button>
      </div>
      <p aria-live="polite" className="min-h-4 text-center text-xs text-slate-600">
        {message}
      </p>
    </div>
  );
}

/** The legend under the photo: the outline, each edge type on this roof with its feet, and the shading. */
function MapLegend({ result, excluded, showEdges }: { result: RoofResult; excluded: readonly number[]; showEdges: boolean }) {
  const ft = edgeFeet(result);
  const data = showEdges ? presentEdges(ft).map((k) => ({ type: k, label: EDGE_INFO[k].label, ft: ft[k] })) : [];
  const shaded = result.faces.some((f) => excluded.includes(f.n));
  const items: ReactNode[] = [];
  if (result.outline.length)
    items.push(
      <li key="outline" className="flex items-center gap-1.5">
        <Swatch color={OUTLINE_COLOR} />
        Roof outline
      </li>,
    );
  for (const e of data)
    items.push(
      <li key={e.type} className="flex items-center gap-1.5">
        <Swatch color={EDGE_INFO[e.type].color} dash={Boolean(EDGE_INFO[e.type].dash)} />
        {e.label} <b className="tabular-nums">{comma(roundFt(e.ft))} ft</b>
      </li>,
    );
  if (shaded)
    items.push(
      <li key="out" className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-3 w-4 rounded-sm ring-1 ring-white/50" style={{ background: 'repeating-linear-gradient(135deg, #fff 0 1.5px, #475569 1.5px 4px)' }} />
        Left out
      </li>,
    );
  if (!items.length) return null;
  return (
    <ul aria-label="Map key" className="-mt-3 flex flex-wrap gap-x-4 gap-y-1.5 rounded-b-2xl bg-slate-800 px-3 pb-2.5 pt-5 text-xs text-white">
      {items}
    </ul>
  );
}

/**
 * Google's aerial photo with the roof outline, the roof edges in their colours, each face's number
 * and the spot Google found. While the estimator is picking the right roof, a tap anywhere on the
 * photo marks that spot.
 */
function SatelliteMap({ result, excluded, showEdges, picking, onTap }: { result: RoofResult; excluded: readonly number[]; showEdges: boolean; picking: Picking; onTap: (p: LatLng) => void }) {
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
  return (
    <div className={cx('relative z-[1] aspect-square w-full overflow-hidden rounded-2xl bg-slate-800 shadow-sm ring-1', picking === 'tap' ? 'ring-4 ring-brand-500' : 'ring-slate-200')}>
      <div className="absolute inset-0" style={{ transform: `scale(${k})` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in proxy image */}
        <img src={satelliteUrl(result)} alt={`Aerial photo of ${result.address ?? 'the house'} with the roof outline${showEdges ? ', the roof edges' : ''} and the numbered roof faces`} width={640} height={640} className="absolute inset-0 h-full w-full" onLoad={() => setState('ok')} onError={() => setState('failed')} />
        <svg viewBox="0 0 640 640" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <pattern id={hatch} patternUnits="userSpaceOnUse" width={11 / k} height={11 / k} patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2={11 / k} stroke="rgba(255,255,255,0.75)" strokeWidth={2.5 / k} />
            </pattern>
          </defs>
          {shapes.faces.map((face) =>
            face.out ? (
              <g key={`f${face.n}`}>
                <polygon points={svgPoints(face.pts)} fill="rgba(15,23,42,0.55)" />
                <polygon points={svgPoints(face.pts)} fill={`url(#${hatch})`} />
              </g>
            ) : (
              <polygon key={`f${face.n}`} points={svgPoints(face.pts)} fill="rgba(255,255,255,0.06)" stroke={showEdges ? 'none' : 'rgba(255,255,255,0.6)'} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ),
          )}
          {shapes.outline.map((ring, i) => (
            <g key={`o${i}`}>
              <polygon points={svgPoints(ring)} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              <polygon points={svgPoints(ring)} fill="none" stroke={OUTLINE_COLOR} strokeWidth={2.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          {showEdges
            ? shapes.edges.map((e, i) => (
                <g key={`e${i}`} data-edge={e.type}>
                  <polyline points={svgPoints(e.pts)} fill="none" stroke="rgba(0,0,0,0.65)" strokeWidth={6.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  <polyline
                    points={svgPoints(e.pts)}
                    fill="none"
                    stroke={EDGE_INFO[e.type].color}
                    strokeWidth={3.5}
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
              <circle cx={at.x} cy={at.y} r={20 / k} fill={out ? '#e2e8f0' : '#0f172a'} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <text x={at.x} y={at.y} textAnchor="middle" dominantBaseline="central" fontSize={23 / k} fontWeight={700} fill={out ? '#475569' : '#fff'}>
                {n}
              </text>
            </g>
          ))}
          <circle cx={shapes.point.x} cy={shapes.point.y} r={11 / k} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={5} vectorEffect="non-scaling-stroke" />
          <circle cx={shapes.point.x} cy={shapes.point.y} r={11 / k} fill="none" stroke="#fff" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
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
      {state !== 'ok' ? (
        <p className="absolute inset-x-0 bottom-3 text-center text-sm text-slate-200">{state === 'loading' ? 'Loading the aerial photo…' : "The aerial photo didn't load. The numbers are still good."}</p>
      ) : null}
    </div>
  );
}

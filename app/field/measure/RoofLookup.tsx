'use client';
// "Look up from the address": the satellite lookup for an area. The Roof Takeoff site finds the
// house on Google's aerial photo and measures the roof; this sheet shows the outline on the photo,
// the attic floor and roof surface, and lets the estimator set the overhang and leave out faces
// with no attic under them (porch, garage) before using the number. Nothing changes until Use.
import { useEffect, useMemo, useState } from 'react';
import type { AreaDraft } from '@/lib/sync/draft';
import type { Measurement } from '@/lib/measure/measure';
import {
  DEFAULT_OVERHANG_IN,
  facing,
  imageryText,
  mapFrame,
  mapZoom,
  noteLine,
  NOT_CONFIGURED_MESSAGE,
  OVERHANG_CHOICES,
  pitchText,
  QUALITY_WORDS,
  roofFigures,
  roofUse,
  roundFt,
  roundSqft,
  SQFT_PER_M2,
  type RoofChoices,
  type RoofResult,
  type RoofUse,
} from '@/lib/roof/lookup';
import { roofLookupService, setLookupChoices, startRoofLookup, stopRoofLookup, useAreaLookup } from '@/lib/offline/roofLookup';
import { Alert, Badge, Button, Card, Chips, cx, Field } from '@/components/ui';
import { useOnline } from '../hooks';

const comma = (n: number) => n.toLocaleString('en-US');
const OVERHANG_OPTIONS = OVERHANG_CHOICES.map((o) => ({ value: String(o), label: o ? `${o}"` : 'None' }));

/** What Use puts into the area. */
export type RoofApply = { use: 'floor' | 'roof'; sqft: number; note: string } | { use: 'walls'; wallRunFt: number; note: string };

/** Whether the lookup can be used here, and the Roof Takeoff site's address (for the full takeoff link). */
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
export function RoofLookupButton({ areaId, address, street, onOpen }: { areaId: string; address: string | null; street: string; onOpen: () => void }) {
  const online = useOnline();
  const state = useAreaLookup(areaId);
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
    : state.last && state.last.address === address
      ? `Looked up ${street.trim()} on this visit. Tap to see it again.`
      : `Measures ${street.trim()} from Google's aerial photo: attic floor, roof and wall run.`;
  return (
    <div className="space-y-1">
      <Button variant="secondary" size="lg" className="w-full" disabled={Boolean(reason)} onClick={onOpen}>
        🛰️ Look up from the address
      </Button>
      <p className={cx('text-xs', reason ? 'text-slate-600' : 'text-slate-500')}>{reason ?? hint}</p>
    </div>
  );
}

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
  const state = useAreaLookup(area.id);
  const { url } = useRoofService(true);
  const use = roofUse(area.jobType, measurement) ?? 'floor';
  const last = state.last && state.last.address === address ? state.last : null;
  const start = () => startRoofLookup({ estimateId, areaId: area.id, address });

  // Opening the sheet looks the address up, unless this visit already did (or is doing) it.
  useEffect(() => {
    const s = state;
    if (!s.running && !(s.last && s.last.address === address)) start();
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Behind the sheet the page shouldn't scroll; Escape closes it on a keyboard.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const [elapsed, setElapsed] = useState(0);
  const startedAt = state.running?.startedAt ?? null;
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  const result = last?.result ?? null;
  const choices: RoofChoices | null = result ? (state.choices ?? { overhangIn: DEFAULT_OVERHANG_IN, excluded: result.defaultExcluded }) : null;
  const f = result && choices ? roofFigures(result, choices) : null;
  const setChoices = (c: Partial<RoofChoices>) => choices && setLookupChoices(area.id, { ...choices, ...c });

  let apply: RoofApply | null = null;
  let applyLabel = '';
  if (result && f) {
    if (use === 'walls') {
      if (f.wallRunFt !== null && roundFt(f.wallRunFt) > 0) {
        apply = { use, wallRunFt: roundFt(f.wallRunFt), note: noteLine(result, f, use) };
        applyLabel = `Use ${comma(roundFt(f.wallRunFt))} ft as the wall run`;
      }
    } else {
      const sqft = roundSqft(use === 'roof' ? f.roofSqft : f.atticFloorSqft);
      if (sqft > 0) {
        apply = { use, sqft, note: noteLine(result, f, use) };
        applyLabel = `Use ${comma(sqft)} sq ft`;
      }
    }
  }

  const fullTakeoff = url ? `${url}/?address=${encodeURIComponent(address)}` : null;

  return (
    <div role="dialog" aria-modal="true" aria-label={`Satellite lookup for ${area.name}`} className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-slate-100">
      <div className="sticky top-0 z-10 bg-white shadow-sm" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-2">
          <h2 className="truncate text-lg font-bold">🛰️ {area.name}</h2>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        {f ? <BigNumbers f={f} use={use} /> : null}
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-4">
        <div role="status" aria-live="polite" className="contents">
          {state.running ? (
            <Card className="space-y-3">
              <div className="flex items-start gap-3">
                <span aria-hidden className="mt-1 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
                <div className="min-w-0">
                  <p className="font-semibold">Looking up {address}</p>
                  <p className="text-sm text-slate-600">Finding the house on Google&apos;s aerial photo and measuring the roof. Usually 10–30 seconds.</p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xl font-extrabold tabular-nums text-slate-700">{elapsed}s</span>
                <Button variant="secondary" onClick={() => stopRoofLookup(area.id)}>
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
              <p className="text-xs text-slate-600">Looked up: {address}</p>
              <Button className="w-full" onClick={start}>
                Try again
              </Button>
            </Card>
          ) : null}
          {!state.running && !state.error && !result ? (
            <Card className="space-y-3">
              <p className="text-sm text-slate-700">Look up {address} on Google&apos;s aerial photo.</p>
              <Button className="w-full" onClick={start}>
                Look up
              </Button>
            </Card>
          ) : null}
        </div>

        {result && f && choices ? (
          <>
            <SatelliteMap key={last?.lookupId} result={result} excluded={choices.excluded} />

            <Card className="space-y-2">
              <p className="font-semibold leading-snug">{result.address ?? 'A spot on the map (no street address)'}</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span>{imageryText(result) ? `Aerial photo from ${imageryText(result)}` : 'Aerial photo date unknown'}</span>
                {result.quality && QUALITY_WORDS[result.quality] ? <Badge tone={QUALITY_WORDS[result.quality]!.tone}>{QUALITY_WORDS[result.quality]!.label}</Badge> : null}
              </div>
              {result.precision !== 'ROOFTOP' ? <Alert>Google placed this address roughly. Make sure the outline is on the right house.</Alert> : null}
              <dl className="grid grid-cols-3 gap-2 pt-1">
                <Fact label="Main pitch" value={f.mainPitch !== null ? pitchText(f.mainPitch) : '—'} />
                <Fact label="Footprint" value={`${comma(roundSqft(f.footprintSqft))} sq ft`} />
                <Fact label="Wall run" value={f.wallRunFt !== null ? `${comma(roundFt(f.wallRunFt))} ft` : '—'} strong={use === 'walls'} />
              </dl>
              {result.perimeterSource === 'none' ? <p className="text-xs text-slate-600">No outline was found, so the overhang can&apos;t be taken off. Check the size on site.</p> : null}
            </Card>

            <Card className="space-y-2">
              <Field label="Roof overhang" group hint="How far the eaves stick out past the walls. The attic floor and wall run are measured inside them.">
                <Chips label="Roof overhang" value={String(choices.overhangIn)} onChange={(v) => setChoices({ overhangIn: Number(v) })} options={OVERHANG_OPTIONS} />
              </Field>
            </Card>

            {result.segments.length ? (
              <Card>
                <h3 className="font-semibold">Roof faces</h3>
                <p className="mt-1 text-xs text-slate-500">Turn off faces with no attic under them, like a porch or a garage you&apos;re quoting on its own. The roof surface always counts every face.</p>
                <ul className="mt-2 divide-y divide-slate-100">
                  {result.segments.map((s) => {
                    const on = !choices.excluded.includes(s.n);
                    return (
                      <li key={s.n} className="flex items-center gap-3 py-2.5">
                        <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold', on ? 'bg-slate-800 text-white' : 'bg-slate-200 text-slate-600')}>{s.n}</span>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">
                            {pitchText(s.rise)} · {facing(s.azimuthDeg, s.rise)}
                          </div>
                          <div className="text-sm text-slate-600">{comma(roundSqft(s.areaM2 * SQFT_PER_M2))} sq ft of roof</div>
                          {s.lowSlope ? <div className="text-xs font-medium text-amber-800">Low slope: porch or flat roof?</div> : null}
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`Face ${s.n} over the attic`}
                          onClick={() => setChoices({ excluded: on ? [...choices.excluded, s.n] : choices.excluded.filter((n) => n !== s.n) })}
                          className="flex min-h-11 shrink-0 flex-col items-center justify-center gap-1 px-1"
                        >
                          <span className={cx('relative h-6 w-11 rounded-full transition-colors', on ? 'bg-brand-600' : 'bg-slate-300')}>
                            <span className={cx('absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', on ? 'translate-x-5.5' : 'translate-x-0.5')} />
                          </span>
                          <span className="text-[11px] leading-none text-slate-600">Over the attic</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ) : (
              <Alert tone="blue">Google has no roof faces for this house, so the roof surface is Google&apos;s whole-roof figure and no faces can be left out.</Alert>
            )}

            {result.warnings.length ? (
              <Card>
                <h3 className="font-semibold">Check on site</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <div className="flex flex-col items-stretch gap-2 pb-2">
              <Button variant="secondary" onClick={start} disabled={Boolean(state.running)}>
                Look up again
              </Button>
              {fullTakeoff ? (
                <a href={fullTakeoff} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center justify-center rounded-xl px-4 font-semibold text-brand-800 hover:bg-brand-50">
                  Open the full roof takeoff ↗
                </a>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {apply ? (
        <div className="sticky bottom-0 z-10 bg-white/95 shadow-[0_-1px_4px_rgba(15,23,42,0.08)] backdrop-blur safe-bottom">
          <div className="mx-auto max-w-2xl px-4 pt-3">
            <Button size="lg" className="w-full" onClick={() => apply && onApply(apply)}>
              {applyLabel}
            </Button>
            <p className="mt-1 text-center text-xs text-slate-500">
              {use === 'roof' ? 'This area is measured on the roofline, so the roof surface goes in.' : use === 'walls' ? 'Sets the wall run in Measure; you add the wall height.' : 'Goes into Square feet, with a line in the prep notes.'}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BigNumbers({ f, use }: { f: ReturnType<typeof roofFigures>; use: RoofUse }) {
  // Walls show three numbers on a phone's width, so each one is a little smaller.
  const three = use === 'walls';
  const tile = (label: string, value: string, unit: string, on: boolean) => (
    <div className={cx('min-w-0 rounded-xl py-1', three ? 'px-2' : 'px-3', on && 'bg-brand-50')}>
      <div className={cx('whitespace-nowrap font-bold uppercase', three ? 'text-[11px]' : 'text-xs tracking-wide', on ? 'text-brand-800' : 'text-slate-500')}>{label}</div>
      <div className={cx('whitespace-nowrap font-extrabold tabular-nums', on ? (three ? 'text-2xl' : 'text-3xl') : three ? 'text-xl' : 'text-2xl', on && 'text-brand-800')}>
        {value}
        <span className={cx('ml-1 font-semibold', three ? 'text-xs' : 'text-sm')}>{unit}</span>
      </div>
    </div>
  );
  return (
    <div className={cx('mx-auto grid max-w-2xl px-4 pb-3', three ? 'grid-cols-3 gap-1' : 'grid-cols-2 gap-2')} aria-live="polite">
      {tile('Attic floor', comma(roundSqft(f.atticFloorSqft)), 'sq ft', use === 'floor')}
      {tile('Roof surface', comma(roundSqft(f.roofSqft)), 'sq ft', use === 'roof')}
      {three ? tile('Wall run', f.wallRunFt !== null ? comma(roundFt(f.wallRunFt)) : '—', 'ft', true) : null}
    </div>
  );
}

function Fact({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={cx('tabular-nums', strong ? 'font-extrabold text-brand-800' : 'font-semibold text-slate-800')}>{value}</dd>
    </div>
  );
}

/** Google's aerial photo with the roof outline, each face's number and the spot Google found. */
function SatelliteMap({ result, excluded }: { result: RoofResult; excluded: readonly number[] }) {
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
  // Each face's number: in the middle of its shape, or at Google's middle of the face without one.
  const shaped = new Set(result.faces.map((f) => f.n));
  const labels = [
    ...result.faces.map((f) => ({ n: f.n, c: f.poly.map(view.toPx).reduce((a, p) => ({ x: a.x + p.x / f.poly.length, y: a.y + p.y / f.poly.length }), { x: 0, y: 0 }) })),
    ...result.segments.filter((s) => !shaped.has(s.n) && s.center).map((s) => ({ n: s.n, c: view.toPx(s.center!) })),
  ];
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-slate-800 shadow-sm ring-1 ring-slate-200">
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in proxy image */}
      <img src={src} alt={`Aerial photo of ${result.address ?? 'the house'}`} width={640} height={640} className="absolute inset-0 h-full w-full" onLoad={() => setState('ok')} onError={() => setState('failed')} />
      {state !== 'ok' ? (
        <p className="absolute inset-x-0 bottom-3 text-center text-sm text-slate-200">{state === 'loading' ? 'Loading the aerial photo…' : "The aerial photo didn't load. The numbers are still good."}</p>
      ) : null}
      <svg viewBox="0 0 640 640" className="absolute inset-0 h-full w-full" aria-hidden>
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
      </svg>
    </div>
  );
}

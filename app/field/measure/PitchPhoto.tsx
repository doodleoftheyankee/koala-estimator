'use client';
// "Pitch from a photo" (the Roof Takeoff page's step 1, inside Measure): the estimator takes or picks
// a photo of a gable end and taps the left eave corner, the peak and the right eave corner. Any point
// can be dragged, with a magnifier while dragging. The reading shows the pitch, its angle and pitch
// factor, each side on its own and whether they agree. Use writes the pitch text into the field the
// sheet was opened from. The photo stays in this page's memory: it isn't uploaded or saved.
import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react';
import {
  clampPt,
  fmt1,
  loupeFor,
  nearestPoint,
  photoFileProblem,
  photoOpenFailed,
  pitchCheck,
  pitchChoices,
  pitchFacts,
  pitchFrom,
  pitchHint,
  shrunkSize,
  type PitchCheck,
  type PitchReading,
  type Pt,
} from '@/lib/measure/pitchPhoto';
import { Alert, Button, cx } from '@/components/ui';
import { Section, Tile } from './RoofTakeoff';

/** The marks on the photo: orange shows on sky, siding and shingles alike. */
const MARK = '#F26B1D';
const LABEL_FONT = '600 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const TIPS = [
  'Stand straight in front of the gable end. Shooting from off to the side makes the pitch read steep.',
  'Back up and zoom in. Distance cuts down lens distortion.',
  'Tilting the phone is fine: the line between the two bottom corners sets level.',
  'Tap the same edge at all three points, such as the top of the rake trim.',
  'Hip roof with no gable? Use a garage or dormer gable with the same pitch.',
];

/** Opens a picked photo, shrunk to at most 2400 px on its long side, as a canvas to draw from. */
async function openPhoto(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    const size = shrunkSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')!.drawImage(img, 0, 0, size.width, size.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type="file"]), [tabindex]:not([tabindex="-1"])';

export function PitchPhotoSheet({ field, onUse, onClose }: { field: string; onUse: (pitch: string) => void; onClose: () => void }) {
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
  const [points, setPoints] = useState<Pt[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const problem = photoFileProblem(file);
    if (problem) return setError(problem);
    setOpening(true);
    setError(null);
    try {
      const canvas = await openPhoto(file);
      setPhoto(canvas);
      setPoints([]);
    } catch {
      setError(photoOpenFailed(file));
    } finally {
      setOpening(false);
    }
  };

  // Focus moves into the sheet when it opens and back to what opened it when it closes; the page
  // behind doesn't scroll. Escape closes only this sheet (Measure, under it, stays open).
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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

  const reading: PitchReading | null = points.length === 3 ? pitchFrom(points[0]!, points[1]!, points[2]!) : null;
  const good = reading && !reading.bad ? reading : null;
  const check = pitchCheck(reading);
  const choices = good ? pitchChoices(good.pitch) : null;
  const hint = pitchHint(points.length);

  // One pair of inputs for both states: the camera, and the phone's photos.
  const inputs = (
    <>
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Take a photo of the gable" onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
      <input ref={library} type="file" accept="image/*" className="hidden" aria-label="Choose a photo of the gable" onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
    </>
  );
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`Pitch from a photo for the ${field}`}
      tabIndex={-1}
      onKeyDown={trapTab}
      className="fixed inset-0 z-[60] flex flex-col overflow-y-auto overscroll-contain bg-slate-100 outline-none"
    >
      <div className="sticky top-0 z-10 bg-white shadow-sm" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold leading-tight">📷 Pitch from a photo</h2>
            <p className="truncate text-xs text-slate-600">For the {field}</p>
          </div>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-4">
        {inputs}
        {photo ? (
          <div className="space-y-2">
            <PitchBoard photo={photo} points={points} setPoints={setPoints} />
            <p aria-live="polite" className="min-h-10 text-sm text-slate-700">
              {hint.step ? <strong className="text-slate-900">{hint.step}: </strong> : null}
              {hint.text}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" disabled={!points.length} onClick={() => setPoints([])}>
                Clear points
              </Button>
              {/* Without capture the phone offers its camera and its photos. */}
              <Button variant="secondary" disabled={opening} onClick={() => library.current?.click()}>
                📷 New photo
              </Button>
            </div>
          </div>
        ) : (
          <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <p className="text-slate-800">Take a photo of a gable end from straight in front. Then tap the two bottom corners of the roof triangle and its peak.</p>
            <div className="grid grid-cols-2 gap-2">
              <Button disabled={opening} onClick={() => camera.current?.click()}>
                📷 Take photo
              </Button>
              <Button variant="secondary" disabled={opening} onClick={() => library.current?.click()}>
                🖼 Choose
              </Button>
            </div>
            <p className="text-xs text-slate-500">The photo isn&apos;t uploaded or saved.</p>
          </section>
        )}
        {opening ? <p className="text-sm text-slate-600">Opening the photo…</p> : null}
        {error ? <Alert>{error}</Alert> : null}

        {photo ? <Reading reading={good} check={check} /> : null}

        {/* Open until there is a photo, then folded away to make room. */}
        <Section key={photo ? 'photo' : 'none'} title="How to shoot the gable" summary="Straight in front, from a distance" startOpen={!photo}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
            {TIPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </Section>
      </div>

      {photo ? (
        <div className="sticky bottom-0 z-10 bg-white/95 shadow-[0_-1px_4px_rgba(15,23,42,0.08)] backdrop-blur safe-bottom">
          <div className="mx-auto max-w-2xl px-4 pt-3">
            {choices ? (
              <div className={cx('grid gap-2', choices.measured ? 'grid-cols-[2fr_3fr]' : 'grid-cols-1')}>
                <Button size="lg" onClick={() => onUse(choices.rounded)}>
                  Use {choices.rounded}
                </Button>
                {choices.measured ? (
                  <Button size="lg" variant="secondary" className="px-3 leading-tight" onClick={() => onUse(choices.measured!)}>
                    <span>
                      Use {choices.measured} <span className="block text-sm font-medium text-slate-600 min-[400px]:inline">(as measured)</span>
                    </span>
                  </Button>
                ) : null}
              </div>
            ) : (
              <Button size="lg" className="w-full" disabled>
                Use
              </Button>
            )}
            {/* The check stays in view here while the points are fine-tuned; the reading has the full words. */}
            <p className={cx('mt-1 text-center text-xs font-medium', check.tone === 'ok' ? 'text-emerald-800' : 'text-amber-800')}>
              {check.short}
              {check.tone === 'ok' ? <span className="font-normal text-slate-500"> Goes into the {field}.</span> : null}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const CHECK_TONE: Record<Exclude<PitchCheck['tone'], 'idle'>, 'green' | 'amber' | 'red'> = { ok: 'green', warn: 'amber', bad: 'red' };

/** The big pitch with its angle and pitch factor, the check right under it, then each side. */
function Reading({ reading, check }: { reading: Extract<PitchReading, { bad: false }> | null; check: PitchCheck }) {
  const f = reading ? pitchFacts(reading) : null;
  return (
    <section aria-label="Pitch reading" className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Measured pitch</div>
          <div className={cx('whitespace-nowrap text-5xl font-extrabold tabular-nums', f ? 'text-brand-800' : 'text-slate-300')} data-testid="pitch-value">
            {f ? f.pitch : '–'}
            <span className="ml-0.5 text-2xl font-bold text-slate-500">/12</span>
          </div>
        </div>
        <dl className="space-y-1 pb-1 text-right text-sm">
          <div>
            <dt className="inline text-slate-600">Angle </dt>
            <dd className="inline font-bold tabular-nums text-slate-900">{f ? `${f.degrees}°` : '–'}</dd>
          </div>
          <div>
            <dt className="inline text-slate-600">Pitch factor </dt>
            <dd className="inline font-bold tabular-nums text-slate-900">{f ? `×${f.factor}` : '–'}</dd>
          </div>
        </dl>
      </div>
      <div aria-live="polite">
        {check.tone === 'idle' ? (
          <p className="text-sm text-slate-600">{check.text}</p>
        ) : (
          <Alert tone={CHECK_TONE[check.tone]}>
            {check.tone === 'ok' ? '✓ ' : null}
            {check.text}
          </Alert>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Left side" value={f ? `${f.left}/12` : '–'} />
        <Tile label="Right side" value={f ? `${f.right}/12` : '–'} />
      </div>
    </section>
  );
}

interface Layout {
  /** Board size in whole screen pixels. */
  w: number;
  h: number;
}

/**
 * Screen pixels per photo pixel, across and down. The board's size is rounded to whole pixels, so
 * the two can differ a little; the photo, the marks and the taps all use these to stay in line.
 */
const scaleOf = ({ w, h }: Layout, photo: HTMLCanvasElement) => ({ kx: w / photo.width, ky: h / photo.height });

/**
 * The photo the estimator taps on. Points are kept in photo pixels; a tap near a point (26 px on a
 * touch screen, 12 px with a mouse) drags it, a tap elsewhere adds the next of the three.
 */
function PitchBoard({ photo, points, setPoints }: { photo: HTMLCanvasElement; points: Pt[]; setPoints: Dispatch<SetStateAction<Pt[]>> }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ index: number; pointerId: number; off: Pt } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);

  // The board fills the width, up to most of the screen's height.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const availW = el.clientWidth;
      if (!availW) return;
      const maxH = Math.max(240, Math.min(window.innerHeight * 0.6, 760));
      const s = Math.min(availW / photo.width, maxH / photo.height);
      setLayout((old) => {
        const next = { w: Math.round(photo.width * s), h: Math.round(photo.height * s) };
        return old && old.w === next.w && old.h === next.h ? old : next;
      });
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [photo]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(layout.w * dpr);
    const ch = Math.round(layout.h * dpr);
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw;
      cv.height = ch;
    }
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(g, photo, points, layout, dragging);
  }, [photo, points, layout, dragging]);

  const toPhoto = (e: ReactPointerEvent<HTMLCanvasElement>): Pt | null => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!layout || !r.width || !r.height) return null;
    return { x: ((e.clientX - r.left) * photo.width) / r.width, y: ((e.clientY - r.top) * photo.height) / r.height };
  };

  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const at = toPhoto(e);
    if (!at || !layout) return;
    let index = nearestPoint(points, at, (e.pointerType === 'mouse' ? 12 : 26) / scaleOf(layout, photo).kx);
    let off = { x: 0, y: 0 };
    if (index >= 0) off = { x: points[index]!.x - at.x, y: points[index]!.y - at.y };
    else {
      if (points.length >= 3) return;
      index = points.length;
      const p = clampPt(at, photo.width, photo.height);
      setPoints([...points, p]);
    }
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone can't be captured; the drag still works while it stays on the photo.
    }
    drag.current = { index, pointerId: e.pointerId, off };
    setDragging(index);
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const at = toPhoto(e);
    if (!at) return;
    const p = clampPt({ x: at.x + d.off.x, y: at.y + d.off.y }, photo.width, photo.height);
    setPoints((pts) => pts.map((q, i) => (i === d.index ? p : q)));
  };
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    setDragging(null);
  };

  return (
    <div ref={box} className="w-full">
      {/* The photo shows once the board knows its size, so a tap always lands where it looks. */}
      {layout ? (
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Gable photo with ${points.length} of 3 points placed`}
          data-testid="pitch-photo"
          data-photo-size={`${photo.width}x${photo.height}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="mx-auto block touch-none select-none rounded-2xl bg-slate-800 shadow-sm ring-1 ring-slate-200"
          style={{ width: layout.w, height: layout.h }}
        />
      ) : (
        <div className="h-60 w-full rounded-2xl bg-slate-800" />
      )}
    </div>
  );
}

type Draw = CanvasRenderingContext2D;

function path(g: Draw, pts: Pt[]) {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
}
function line(g: Draw, a: Pt, b: Pt, color: string, w: number, dash?: number[]) {
  g.save();
  if (dash) g.setLineDash(dash);
  g.lineCap = 'round';
  path(g, [a, b]);
  g.strokeStyle = 'rgba(0,0,0,.55)';
  g.lineWidth = w + 3;
  g.stroke();
  g.strokeStyle = color;
  g.lineWidth = w;
  g.stroke();
  g.restore();
}
function handle(g: Draw, p: Pt, ring: boolean) {
  g.save();
  if (ring) {
    g.beginPath();
    g.arc(p.x, p.y, 10, 0, Math.PI * 2);
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0,0,0,.5)';
    g.stroke();
    g.lineWidth = 2;
    g.strokeStyle = MARK;
    g.stroke();
  } else {
    g.beginPath();
    g.arc(p.x, p.y, 7, 0, Math.PI * 2);
    g.fillStyle = MARK;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#fff';
    g.stroke();
    g.beginPath();
    g.arc(p.x, p.y, 8.5, 0, Math.PI * 2);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0,0,0,.45)';
    g.stroke();
  }
  g.restore();
}
function pill(g: Draw, text: string, x: number, y: number) {
  g.save();
  g.font = LABEL_FONT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(text).width + 14;
  g.beginPath();
  if (g.roundRect) g.roundRect(x - w / 2, y - 11, w, 22, 6);
  else g.rect(x - w / 2, y - 11, w, 22);
  g.fillStyle = 'rgba(12,17,22,.8)';
  g.fill();
  g.fillStyle = '#fff';
  g.fillText(text, x, y + 0.5);
  g.restore();
}

/** A side's pitch beside the middle of its roof line, on the outside of the triangle (away from `other`). */
function sideLabel(g: Draw, text: string, a: Pt, b: Pt, other: Pt) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let nx = -(b.y - a.y) / len;
  let ny = (b.x - a.x) / len;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (nx * (other.x - mid.x) + ny * (other.y - mid.y) > 0) {
    nx = -nx;
    ny = -ny;
  }
  pill(g, text, mid.x + nx * 24, mid.y + ny * 24);
}

/** The two roof lines, the dashed eave line and plumb line, each side's pitch and the points. */
function overlay(g: Draw, pts: Pt[], toBoard: (p: Pt) => Pt, inLoupe: boolean) {
  const P = pts.map(toBoard);
  if (P.length >= 2) line(g, P[0]!, P[1]!, MARK, 2.5);
  if (P.length === 3) {
    line(g, P[1]!, P[2]!, MARK, 2.5);
    line(g, P[0]!, P[2]!, '#fff', 1.5, [6, 5]);
    const r = pitchFrom(pts[0]!, pts[1]!, pts[2]!);
    if (!r.bad) {
      line(g, P[1]!, toBoard(r.foot), '#fff', 1.5, [6, 5]);
      if (!inLoupe) {
        sideLabel(g, `${fmt1(r.left)}/12`, P[0]!, P[1]!, P[2]!);
        sideLabel(g, `${fmt1(r.right)}/12`, P[1]!, P[2]!, P[0]!);
      }
    }
  }
  P.forEach((p) => handle(g, p, inLoupe));
}

function paint(g: Draw, photo: HTMLCanvasElement, pts: Pt[], layout: Layout, dragging: number | null) {
  const { w, h } = layout;
  const { kx, ky } = scaleOf(layout, photo);
  g.clearRect(0, 0, w, h);
  g.drawImage(photo, 0, 0, w, h);
  overlay(g, pts, (p) => ({ x: p.x * kx, y: p.y * ky }), false);
  const pt = dragging === null ? undefined : pts[dragging];
  if (!pt) return;
  // The magnifier, in the top corner away from the finger.
  const L = loupeFor(pt, photo, w, kx);
  g.save();
  g.beginPath();
  g.arc(L.cx, L.cy, L.r, 0, Math.PI * 2);
  g.fillStyle = '#0B0F13';
  g.fill();
  g.clip();
  if (L.src) g.drawImage(photo, L.src.x, L.src.y, L.src.w, L.src.h, L.dst.x, L.dst.y, L.dst.w, L.dst.h);
  overlay(g, pts, (p) => ({ x: L.cx + (p.x - pt.x) * L.scale, y: L.cy + (p.y - pt.y) * L.scale }), true);
  g.strokeStyle = 'rgba(255,255,255,.95)';
  g.lineWidth = 1;
  for (const [a, b] of [
    [{ x: L.cx - L.r, y: L.cy }, { x: L.cx - 4, y: L.cy }],
    [{ x: L.cx + 4, y: L.cy }, { x: L.cx + L.r, y: L.cy }],
    [{ x: L.cx, y: L.cy - L.r }, { x: L.cx, y: L.cy - 4 }],
    [{ x: L.cx, y: L.cy + 4 }, { x: L.cx, y: L.cy + L.r }],
  ] as const) {
    path(g, [a, b]);
    g.stroke();
  }
  g.restore();
  g.beginPath();
  g.arc(L.cx, L.cy, L.r, 0, Math.PI * 2);
  g.lineWidth = 3;
  g.strokeStyle = '#fff';
  g.stroke();
  g.beginPath();
  g.arc(L.cx, L.cy, L.r + 2, 0, Math.PI * 2);
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(0,0,0,.5)';
  g.stroke();
}

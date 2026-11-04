'use client';
// Shape input for a measurement or cutout: preset picker (rectangle, L, T, U, custom), a drawing
// with every side labelled, and the length boxes. Custom outlines are sketched on a tap grid.
import { useState } from 'react';
import { PRESET_DIMS, SHAPE_NAMES, solveShape, type Point, type ShapeInput, type ShapeKind, type SolvedShape } from '@/lib/measure/geometry';
import { layoutShape } from '@/lib/measure/layout';
import { formatFeet, parseFeet } from '@/lib/measure/units';
import { Button, cx } from '@/components/ui';

const ICONS: Record<ShapeKind, string> = {
  rect: 'M4 6h16v12H4z',
  L: 'M4 4h8v8h8v8H4z',
  T: 'M3 4h18v7h-6v9H9v-9H3z',
  U: 'M3 4h6v9h6V4h6v16H3z',
  custom: 'M4 18l3-12 7 3 6-4-2 15z',
};

/** A length box that accepts 24'6", 24.5, 294" or "24 6", and turns red when it can't read it. */
export function LengthInput({ label, value, onChange, placeholder = `e.g. 24'6"` }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const bad = value.trim() !== '' && parseFeet(value) === null;
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="next"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={bad}
        className={cx(
          'block min-h-12 w-full rounded-xl border px-3 text-lg text-slate-900 placeholder:text-base placeholder:text-slate-400 focus:outline-none focus:ring-2',
          bad ? 'border-red-500 bg-red-50 focus:ring-red-100' : 'border-slate-300 bg-white focus:border-brand-600 focus:ring-brand-100',
        )}
      />
    </label>
  );
}

/** The labelled outline drawing. */
export function ShapePreview({ shape, empty, compact }: { shape: SolvedShape | null; empty: string; compact?: boolean }) {
  const layout = shape ? layoutShape(shape) : null;
  return (
    <svg viewBox="0 0 320 240" className={cx('block w-full rounded-xl bg-slate-50', compact && 'max-h-44')} role="img" aria-label={shape ? `Outline, ${Math.round(shape.area)} square feet` : empty}>
      {layout ? (
        <>
          <path d={layout.path} className="fill-brand-50 stroke-brand-700" strokeWidth={3} strokeLinejoin="round" />
          {layout.labels.map((l, i) => (
            <text
              key={i}
              x={l.x.toFixed(1)}
              y={l.y.toFixed(1)}
              textAnchor="middle"
              dominantBaseline="middle"
              transform={l.vertical ? `rotate(-90 ${l.x.toFixed(1)} ${l.y.toFixed(1)})` : undefined}
              className={l.lettered ? 'fill-slate-900 font-extrabold' : 'fill-slate-500'}
              style={{ fontSize: 13, paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 4 }}
            >
              {l.text}
            </text>
          ))}
        </>
      ) : (
        <text x={160} y={120} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 15 }}>
          {empty}
        </text>
      )}
    </svg>
  );
}

export function ShapeEditor({ shape, onChange, compact }: { shape: ShapeInput; onChange: (s: ShapeInput) => void; compact?: boolean }) {
  const solved = solveShape(shape);
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Shape" className="grid grid-cols-5 gap-1.5">
        {(Object.keys(SHAPE_NAMES) as ShapeKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={kind === shape.kind}
            onClick={() => onChange({ ...shape, kind, custom: kind === 'custom' ? (shape.custom ?? { points: [], closed: false, sides: [] }) : shape.custom })}
            className={cx(
              'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-xs font-semibold ring-1',
              kind === shape.kind ? 'bg-brand-50 text-brand-800 ring-2 ring-brand-600' : 'bg-white text-slate-700 ring-slate-300',
            )}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
              <path d={ICONS[kind]} />
            </svg>
            {SHAPE_NAMES[kind].replace('-shape', '')}
          </button>
        ))}
      </div>

      <ShapePreview shape={solved.ok ? solved.shape : null} empty={shape.kind === 'custom' ? 'Draw the outline below' : 'Enter the sizes'} compact={compact} />
      <p className="min-h-5 text-center text-sm font-semibold text-slate-700">
        {solved.ok ? `${Math.round(solved.shape.area).toLocaleString('en-US')} sq ft · perimeter ${formatFeet(solved.shape.perimeter)}` : ''}
      </p>

      {shape.kind === 'custom' ? (
        <CustomGrid shape={shape} onChange={onChange} />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {PRESET_DIMS[shape.kind].map(({ key, label }) => (
            <LengthInput key={key} label={`${key} · ${label}`} value={shape.dims[key] ?? ''} onChange={(v) => onChange({ ...shape, dims: { ...shape.dims, [key]: v } })} />
          ))}
        </div>
      )}
    </div>
  );
}

const GRID_FT = 2; // one square = 2 ft
const GRID_N = 24; // 48 ft sketch area
const CELL = 300 / GRID_N;

/**
 * Tap corners on a grid to sketch the outline, then type each side's real length. The sketch
 * only sets directions and proportions; blank sides fall back to their sketched length.
 */
function CustomGrid({ shape, onChange }: { shape: ShapeInput; onChange: (s: ShapeInput) => void }) {
  const custom = shape.custom ?? { points: [], closed: false, sides: [] };
  const [confirmClear, setConfirmClear] = useState(false);
  const set = (c: typeof custom) => onChange({ ...shape, custom: c });

  const toScreen = (p: Point): Point => [(p[0] / GRID_FT) * CELL, 300 - (p[1] / GRID_FT) * CELL];
  const pts = custom.points.map(toScreen);

  const close = () => {
    if (custom.points.length < 3) return;
    set({ ...custom, closed: true, sides: custom.points.map((_, i) => custom.sides[i] ?? '') });
  };

  const tap = (e: React.PointerEvent<SVGSVGElement>) => {
    if (custom.closed) return;
    const svg = e.currentTarget;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const gx = Math.round(Math.min(Math.max(pt.x, 0), 300) / CELL);
    const gy = Math.round(Math.min(Math.max(pt.y, 0), 300) / CELL);
    const p: Point = [gx * GRID_FT, (GRID_N - gy) * GRID_FT];
    const first = custom.points[0];
    if (first && custom.points.length >= 3 && first[0] === p[0] && first[1] === p[1]) return close();
    const last = custom.points.at(-1);
    if (last && last[0] === p[0] && last[1] === p[1]) return;
    set({ ...custom, points: [...custom.points, p] });
  };

  const sideCount = custom.closed ? pts.length : Math.max(pts.length - 1, 0);
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        {custom.closed
          ? "Type each side's real length. Blank sides use the sketch."
          : custom.points.length === 0
            ? `Tap the corners in order. One square = ${GRID_FT} ft; the sketch sets the shape, your typed lengths set the size.`
            : 'Keep tapping corners. Tap the first (hollow) corner again to close.'}
      </p>
      <svg viewBox="-6 -6 312 312" className="block w-full touch-none rounded-xl bg-white ring-1 ring-slate-300" onPointerUp={tap} aria-label="Drawing grid: tap corners in order">
        {Array.from({ length: GRID_N + 1 }, (_, i) => (
          <g key={i} className={i % 5 === 0 ? 'stroke-slate-300' : 'stroke-slate-200'} strokeWidth={i % 5 === 0 ? 1.2 : 0.5}>
            <line x1={i * CELL} y1={0} x2={i * CELL} y2={300} />
            <line x1={0} y1={i * CELL} x2={300} y2={i * CELL} />
          </g>
        ))}
        {pts.length > 1 ? (
          <path
            d={pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ') + (custom.closed ? 'Z' : '')}
            className={cx('stroke-brand-700', custom.closed ? 'fill-brand-100' : 'fill-none')}
            fillOpacity={0.6}
            strokeWidth={3}
            strokeLinejoin="round"
          />
        ) : null}
        {pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={i === 0 ? 7 : 5} className={i === 0 ? 'fill-white stroke-brand-700' : 'fill-brand-700'} strokeWidth={3} />
        ))}
        {Array.from({ length: sideCount }, (_, i) => {
          const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          return (
            <g key={`s${i}`}>
              <circle cx={mx} cy={my} r={9} className="fill-slate-900" />
              <text x={mx} y={my} textAnchor="middle" dominantBaseline="central" className="fill-white font-bold" style={{ fontSize: 11 }}>
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="grid grid-cols-3 gap-2">
        <Button
          variant="secondary"
          disabled={custom.points.length === 0}
          onClick={() =>
            custom.closed
              ? set({ ...custom, closed: false })
              : set({ ...custom, points: custom.points.slice(0, -1), sides: custom.sides.slice(0, custom.points.length - 1) })
          }
        >
          {custom.closed ? 'Reopen' : 'Undo'}
        </Button>
        <Button
          variant={confirmClear ? 'danger' : 'secondary'}
          disabled={custom.points.length === 0}
          onClick={() => {
            if (!confirmClear) return setConfirmClear(true);
            setConfirmClear(false);
            set({ points: [], closed: false, sides: [] });
          }}
          onBlur={() => setConfirmClear(false)}
        >
          {confirmClear ? 'Tap to clear' : 'Clear'}
        </Button>
        <Button disabled={custom.closed || custom.points.length < 3} onClick={close}>
          Close
        </Button>
      </div>
      {custom.closed ? (
        <div className="grid grid-cols-2 gap-3">
          {custom.points.map((p, i) => {
            const q = custom.points[(i + 1) % custom.points.length]!;
            return (
              <LengthInput
                key={i}
                label={`Side ${i + 1}`}
                value={custom.sides[i] ?? ''}
                placeholder={`sketch: ${formatFeet(Math.hypot(q[0] - p[0], q[1] - p[1]))}`}
                onChange={(v) => set({ ...custom, sides: custom.points.map((_, j) => (j === i ? v : (custom.sides[j] ?? ''))) })}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

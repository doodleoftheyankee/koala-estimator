'use client';
// Full-screen measuring for one estimate area (the AtticScan tools). Every change is saved to the
// draft as it happens; when the measurement is complete its net becomes the area's square feet.
import { useEffect } from 'react';
import type { AreaDraft } from '@/lib/sync/draft';
import { computeMeasurement, CUTOUT_NAMES, MEASURE_MODES, MODE_INFO, newCutout, pitchFactor, type Measurement } from '@/lib/measure/measure';
import { parsePitch } from '@/lib/measure/units';
import { Alert, Button, Card, Chips, Field, Input, Toggle } from '@/components/ui';
import { LengthInput, ShapeEditor } from './ShapeEditor';

const sq = (n: number) => Math.round(n).toLocaleString('en-US');

function factorText(pitch: string): string {
  const p = parsePitch(pitch);
  return p === null ? '' : `×${pitchFactor(p).toFixed(3)}`;
}

export function MeasureSheet({
  area,
  measurement: m,
  onChange,
  onRemove,
  onClose,
}: {
  area: AreaDraft;
  measurement: Measurement;
  onChange: (m: Measurement) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const r = computeMeasurement(m);
  const set = (patch: Partial<Measurement>) => onChange({ ...m, ...patch });
  const isWalls = m.mode === 'walls';

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

  return (
    <div role="dialog" aria-modal="true" aria-label={`Measure ${area.name}`} className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-slate-100">
      <div className="sticky top-0 z-10 bg-white shadow-sm" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-2">
          <h2 className="truncate text-lg font-bold">📐 {area.name}</h2>
          <Button onClick={onClose}>{r.net > 0 && !r.errors.length ? `Use ${sq(r.net)} sq ft` : 'Done'}</Button>
        </div>
        <div className="mx-auto grid max-w-2xl grid-cols-[1fr_1fr_1.3fr] gap-2 px-4 pb-3" aria-live="polite">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Gross</div>
            <div className="text-2xl font-extrabold tabular-nums">{sq(r.gross)}</div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Cutouts</div>
            <div className="text-2xl font-extrabold tabular-nums">{r.cutouts ? `−${sq(r.cutouts)}` : '0'}</div>
          </div>
          <div className="rounded-xl bg-brand-50 px-3 py-1">
            <div className="text-xs font-bold uppercase tracking-wide text-brand-800">Net sq ft</div>
            <div className="text-3xl font-extrabold tabular-nums text-brand-800">{sq(r.net)}</div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 pb-16">
        {r.basis && !r.errors.length ? <p className="text-sm text-slate-600">{r.basis}</p> : null}
        {r.errors.map((e) => (
          <Alert key={e}>{e}</Alert>
        ))}
        {r.notes.map((n) => (
          <Alert key={n} tone="blue">
            {n}
          </Alert>
        ))}

        <Card className="space-y-3">
          <Field label="Measure as" group hint={MODE_INFO[m.mode].hint}>
            <Chips label="Measure as" value={m.mode} onChange={(mode) => set({ mode })} options={MEASURE_MODES.map((v) => ({ value: v, label: MODE_INFO[v].label }))} />
          </Field>
          <p className="text-xs text-slate-500">
            Lengths: type 24&apos;6&quot;, 24.5, 294&quot; — or <strong>24 6</strong> for 24 ft 6 in.
          </p>
        </Card>

        {m.mode === 'roofline' ? (
          <Card className="space-y-3">
            <h3 className="font-semibold">Pitch</h3>
            <div className="flex items-end gap-3">
              <Field label="Roof pitch (rise / 12)" className="flex-1">
                <Input inputMode="decimal" value={m.pitch} placeholder="e.g. 6/12" onChange={(e) => set({ pitch: e.target.value })} />
              </Field>
              <span className="mb-3 w-20 font-bold text-brand-800">{factorText(m.pitch)}</span>
            </div>
            <Toggle checked={m.twoSlope} onChange={(twoSlope) => set({ twoSlope })} label="Two different slopes" />
            {m.twoSlope ? (
              <>
                <div className="flex items-end gap-3">
                  <Field label="Second pitch (rise / 12)" className="flex-1">
                    <Input inputMode="decimal" value={m.pitch2} placeholder="e.g. 12/12" onChange={(e) => set({ pitch2: e.target.value })} />
                  </Field>
                  <span className="mb-3 w-20 font-bold text-brand-800">{factorText(m.pitch2)}</span>
                </div>
                <Field label="% of footprint at the first pitch">
                  <Input inputMode="decimal" value={m.splitPct} onChange={(e) => set({ splitPct: e.target.value })} />
                </Field>
              </>
            ) : null}
            <p className="text-xs text-slate-500">Roof area = footprint × √(1 + (rise/12)²). Measure skylights on the roof surface.</p>
          </Card>
        ) : null}

        {isWalls ? (
          <Card className="space-y-3">
            <h3 className="font-semibold">Walls</h3>
            <LengthInput label="Average wall height" value={m.wallHeight} placeholder={`e.g. 8' or 3'6"`} onChange={(wallHeight) => set({ wallHeight })} />
            <LengthInput label="Total wall length (optional)" value={m.perimeter} placeholder="Blank = perimeter of the outline below" onChange={(perimeter) => set({ perimeter })} />
          </Card>
        ) : null}

        {!(isWalls && m.perimeter.trim()) ? (
          <Card>
            <h3 className="mb-3 font-semibold">{isWalls ? 'Outline (its perimeter is the wall length)' : m.mode === 'roofline' ? 'Footprint (plan view)' : 'Shape'}</h3>
            <ShapeEditor shape={m.shape} onChange={(shape) => set({ shape })} />
          </Card>
        ) : null}

        <Card className="space-y-3">
          <h3 className="font-semibold">{isWalls ? 'Windows, doors and vents' : 'Cutouts'}</h3>
          <p className="text-sm text-slate-600">{isWalls ? 'Openings subtracted from the wall area.' : 'Areas not getting insulation, subtracted from the gross.'}</p>
          {m.cutouts.map((c, i) => {
            const cr = r.cutoutResults.find((x) => x.id === c.id);
            const patch = (p: Partial<typeof c>) => set({ cutouts: m.cutouts.map((x) => (x.id === c.id ? { ...x, ...p } : x)) });
            return (
              <div key={c.id} className="space-y-3 border-t-2 border-dashed border-slate-200 pt-3">
                <div className="flex items-center gap-3">
                  <strong>#{i + 1}</strong>
                  <span className="text-sm font-semibold text-slate-600">{cr?.errors.length ? cr.errors[0] : `${sq(cr?.area ?? 0)} sq ft`}</span>
                  <Button size="sm" variant="ghost" className="ml-auto text-red-700" onClick={() => set({ cutouts: m.cutouts.filter((x) => x.id !== c.id) })} aria-label={`Remove ${c.label}`}>
                    Remove
                  </Button>
                </div>
                <div className="grid grid-cols-[1fr_6rem] gap-3">
                  <Field label="Name">
                    <Input value={c.label} onChange={(e) => patch({ label: e.target.value })} />
                  </Field>
                  <Field label="How many">
                    <Input inputMode="numeric" value={c.qty} onChange={(e) => patch({ qty: e.target.value })} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {CUTOUT_NAMES[m.mode].map((name) => (
                    <button key={name} type="button" onClick={() => patch({ label: name })} className="min-h-10 rounded-full bg-white px-3 text-sm ring-1 ring-slate-300">
                      {name}
                    </button>
                  ))}
                </div>
                <ShapeEditor compact shape={c.shape} onChange={(shape) => patch({ shape })} />
              </div>
            );
          })}
          <Button variant="secondary" className="w-full" onClick={() => set({ cutouts: [...m.cutouts, newCutout(m.mode)] })}>
            {isWalls ? '+ Add window, door or vent' : '+ Add cutout'}
          </Button>
        </Card>

        <Button variant="ghost" className="w-full text-red-700" onClick={onRemove}>
          Remove this measurement
        </Button>
      </div>
    </div>
  );
}

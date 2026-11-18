'use client';
import { useState } from 'react';
import { codeMinimumR, JOB_TYPES, ACCESS_LEVELS, type PricingBundle } from '@/lib/pricing';
import { areaSchema, newArea, type AreaDraft, type EstimateDraft } from '@/lib/sync/draft';
import { ACCESS_HINTS, ACCESS_LABELS, JOB_TYPE_LABELS, num } from '@/lib/format';
import { Alert, Badge, Button, Card, Chips, Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import { Button as DmButton, Ruler } from '@/components/daymark';
import type { Update } from './EstimateEditor';
import { measuredSqft, measurementSummary, newMeasurement, type Measurement } from '@/lib/measure/measure';
import { MeasureSheet } from './measure/MeasureSheet';
import { AreaPhotos, useRemotePhotos } from './measure/AreaPhotos';
import { removeAreaPhotos } from '@/lib/offline/photos';
import { PhotoRead } from './measure/PhotoRead';
import { EXISTING_MATERIALS, type StoredPhotoRead, type Suggestion } from '@/lib/ai/photoRead';
import { lookupAddress, mergeNotes, ROOF_LOOKUP_JOBS } from '@/lib/roof/lookup';
import { RoofLookupButton, RoofLookupSheet, type RoofApply } from './measure/RoofLookup';

const EXISTING = EXISTING_MATERIALS;
const CAVITY_DEPTHS = [
  { value: '3.5', label: '2×4 (3.5")' },
  { value: '5.5', label: '2×6 (5.5")' },
  { value: '7.25', label: '2×8 (7.25")' },
  { value: '9.25', label: '2×10 (9.25")' },
] as const;
const CAVITY_JOBS = new Set(['walls', 'rim_joist', 'crawlspace', 'garage']);

export function AreasStep({ draft, update, bundle, ownerId }: { draft: EstimateDraft; update: Update; bundle: PricingBundle | null; ownerId: string }) {
  const remotePhotos = useRemotePhotos(draft.id);
  const [open, setOpen] = useState<string | null>(draft.areas.at(-1)?.id ?? null);
  const [measuring, setMeasuring] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState<string | null>(null);
  const [roofDone, setRoofDone] = useState<{ areaId: string; text: string } | null>(null);
  const address = lookupAddress(draft.property);

  const add = (jobType: AreaDraft['jobType']) => {
    const a = newArea(jobType);
    update((d) => ({ ...d, areas: [...d.areas, a] }));
    setOpen(a.id);
  };
  const set = (id: string, patch: Partial<AreaDraft>) =>
    update((d) => ({ ...d, areas: d.areas.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const remove = (id: string) => {
    void removeAreaPhotos(id);
    update((d) => {
      return { ...d, areas: d.areas.filter((a) => a.id !== id), measurements: without(d.measurements, id), photoReads: without(d.photoReads, id) };
    });
  };

  /** Saves the measurement; once it's complete, its net becomes the area's square feet. */
  const setMeasurement = (id: string, m: Measurement) =>
    update((d) => {
      const sqft = measuredSqft(m);
      return {
        ...d,
        measurements: { ...d.measurements, [id]: m },
        areas: sqft === null ? d.areas : d.areas.map((a) => (a.id === id ? { ...a, sqft } : a)),
      };
    });
  const removeMeasurement = (id: string) =>
    update((d) => {
      return { ...d, measurements: without(d.measurements, id) };
    });
  const measuringArea = measuring ? draft.areas.find((a) => a.id === measuring) : undefined;

  const setPhotoRead = (id: string, r: StoredPhotoRead) => update((d) => ({ ...d, photoReads: { ...d.photoReads, [id]: r } }));
  const decide = (id: string, key: string, decision: 'applied' | 'dismissed') =>
    update((d) => {
      const r = d.photoReads[id];
      return r ? { ...d, photoReads: { ...d.photoReads, [id]: { ...r, decisions: { ...r.decisions, [key]: decision } } } } : d;
    });
  /** Applies one suggestion from a photo read: area fields, or the measurement (cutouts). */
  const applySuggestion = (id: string, s: Suggestion) => {
    if (s.patch) set(id, s.patch);
    if (s.measurement) setMeasurement(id, s.measurement);
  };
  /** Uses a satellite lookup: the area's square feet, or the wall run in its measurement; plus a prep-note line. */
  const applyRoof = (id: string, a: RoofApply) => {
    const wallsWith = (m: Measurement | undefined, runFt: number): Measurement => ({ ...(m ?? newMeasurement('walls')), mode: 'walls', perimeter: String(runFt) });
    update((d) => {
      const area = d.areas.find((x) => x.id === id);
      if (!area) return d;
      const prepNotes = mergeNotes(area.prepNotes, a.note);
      if (a.use !== 'walls') return { ...d, areas: d.areas.map((x) => (x.id === id ? { ...x, sqft: a.sqft, prepNotes } : x)) };
      const m = wallsWith(d.measurements[id], a.wallRunFt);
      const sqft = measuredSqft(m);
      return {
        ...d,
        measurements: { ...d.measurements, [id]: m },
        areas: d.areas.map((x) => (x.id === id ? { ...x, prepNotes, ...(sqft === null ? {} : { sqft }) } : x)),
      };
    });
    const wallSqft = a.use === 'walls' ? measuredSqft(wallsWith(draft.measurements[id], a.wallRunFt)) : null;
    const text =
      a.use !== 'walls'
        ? `Square feet set to ${num(a.sqft)} (${a.what}) from the satellite lookup, with a line in the prep notes.`
        : wallSqft === null
          ? `Wall run set to ${num(a.wallRunFt)} ft. Add the wall height in Measure to get the square feet.`
          : `Wall run set to ${num(a.wallRunFt)} ft: ${num(wallSqft)} sq ft of wall.`;
    setLookingUp(null);
    setRoofDone({ areaId: id, text });
  };
  const lookingUpArea = lookingUp ? draft.areas.find((a) => a.id === lookingUp) : undefined;
  const codeFor = (jobType: AreaDraft['jobType']) => (bundle ? codeMinimumR(bundle.snapshot, jobType) : null);

  return (
    <>
      {draft.areas.map((a) => {
        const valid = areaSchema.safeParse(a).success;
        const codeR = bundle ? codeMinimumR(bundle.snapshot, a.jobType) : null;
        const expanded = open === a.id;
        return (
          <Card key={a.id}>
            <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen(expanded ? null : a.id)} aria-expanded={expanded}>
              <span className="min-w-0">
                <span className="block truncate font-semibold">{a.name}</span>
                <span className="block text-sm text-slate-600">
                  {JOB_TYPE_LABELS[a.jobType]} · {a.sqft ? `${num(a.sqft)} sq ft${draft.measurements[a.id] ? ', measured' : ''}` : 'no size yet'} · R-{a.currentR} → {a.targetR ? `R-${a.targetR}` : codeR ? `code R-${codeR}` : 'code'}
                </span>
              </span>
              {valid ? <Badge tone="green">Ready</Badge> : <Badge tone="amber">Incomplete</Badge>}
            </button>

            {expanded ? (
              <div className="mt-4 space-y-4">
                <Field label="Area name">
                  <Input value={a.name} onChange={(e) => set(a.id, { name: e.target.value })} />
                </Field>
                <Field label="Job type" group>
                  <Chips label="Job type" value={a.jobType} onChange={(v) => set(a.id, { jobType: v })} options={JOB_TYPES.map((j) => ({ value: j, label: JOB_TYPE_LABELS[j] }))} />
                </Field>
                <MeasureButton
                  measurement={draft.measurements[a.id]}
                  sqft={a.sqft}
                  onOpen={() => {
                    if (!draft.measurements[a.id]) setMeasurement(a.id, newMeasurement(a.jobType));
                    setRoofDone(null);
                    setMeasuring(a.id);
                  }}
                  onUseMeasured={(sqft) => set(a.id, { sqft })}
                />
                {ROOF_LOOKUP_JOBS.has(a.jobType) ? (
                  <RoofLookupButton
                    estimateId={draft.id}
                    address={address}
                    street={draft.property.street}
                    onOpen={() => {
                      setRoofDone(null);
                      setLookingUp(a.id);
                    }}
                  />
                ) : null}
                {roofDone?.areaId === a.id ? (
                  <div role="status">
                    <Alert tone="green">{roofDone.text}</Alert>
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Square feet">
                    <NumberInput value={a.sqft || null} onValue={(v) => set(a.id, { sqft: v ?? 0 })} placeholder="0" />
                  </Field>
                  <Field label="Target R" hint={codeR ? `Blank = tier default (code R-${codeR})` : 'Blank = tier default'}>
                    <NumberInput value={a.targetR} onValue={(v) => set(a.id, { targetR: v && v > 0 ? v : null })} placeholder={codeR ? `R-${codeR}` : ''} />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Existing insulation">
                    <Select
                      value={a.existingMaterial ?? 'None'}
                      onChange={(e) => set(a.id, { existingMaterial: e.target.value === 'None' ? null : e.target.value })}
                    >
                      {EXISTING.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Existing depth (in)">
                    <NumberInput value={a.existingDepthIn} onValue={(v) => set(a.id, { existingDepthIn: v })} />
                  </Field>
                </div>
                <Field label="Current R-value" hint="Estimate from type and depth if there is no label." group>
                  <div className="flex items-start gap-2">
                    <NumberInput aria-label="Current R-value" className="w-24" value={a.currentR} onValue={(v) => set(a.id, { currentR: v ?? 0 })} />
                    <Chips label="Common R-values" value={String(a.currentR)} onChange={(v) => set(a.id, { currentR: Number(v) })} options={['0', '11', '19', '30'].map((r) => ({ value: r, label: `R-${r}` }))} />
                  </div>
                </Field>
                {a.existingMaterial === 'Vermiculite' ? (
                  <Alert tone="red">
                    Vermiculite may contain asbestos. Do not disturb it. Note it below; the office decides on testing before any work is quoted.
                  </Alert>
                ) : null}

                {CAVITY_JOBS.has(a.jobType) ? (
                  <Field label="Cavity depth" hint="Caps how much insulation fits. Leave blank for open areas." group>
                    <div className="flex flex-wrap items-center gap-2">
                      <Chips label="Framing" value={a.depthIn === null ? null : (String(a.depthIn) as (typeof CAVITY_DEPTHS)[number]['value'])} onChange={(v) => set(a.id, { depthIn: Number(v) })} options={CAVITY_DEPTHS} />
                      {a.depthIn !== null ? (
                        <Button size="sm" variant="ghost" onClick={() => set(a.id, { depthIn: null })}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </Field>
                ) : null}

                <Field label="Access" group>
                  <Chips label="Access difficulty" value={a.accessLevel} onChange={(v) => set(a.id, { accessLevel: v })} options={ACCESS_LEVELS.map((l) => ({ value: l, label: ACCESS_LABELS[l] }))} />
                  <span className="mt-1 block text-xs text-slate-500">{ACCESS_HINTS[a.accessLevel]}</span>
                </Field>

                <Toggle
                  checked={a.removalNeeded}
                  onChange={(v) => set(a.id, { removalNeeded: v })}
                  label="Remove old insulation"
                  hint="Required removal on every option (damaged, wet, rodent, or customer request)."
                />

                <AreaPhotos estimateId={draft.id} areaId={a.id} ownerId={ownerId} remote={remotePhotos.photos} onRemoteDeleted={remotePhotos.reload} />
                <PhotoRead
                  context={{ estimateId: draft.id, yearBuilt: draft.property.yearBuilt, codeR: codeFor(a.jobType) }}
                  area={a}
                  measurement={draft.measurements[a.id]}
                  stored={draft.photoReads[a.id]}
                  remote={remotePhotos.photos}
                  onRead={(r) => setPhotoRead(a.id, r)}
                  onApply={(s) => applySuggestion(a.id, s)}
                  onDecide={(key, decision) => decide(a.id, key, decision)}
                />

                <Field label="Prep notes / obstructions">
                  <Textarea rows={2} value={a.prepNotes ?? ''} onChange={(e) => set(a.id, { prepNotes: e.target.value || null })} />
                </Field>

                <div className="flex justify-between">
                  <Button variant="danger" size="sm" onClick={() => remove(a.id)}>
                    Delete area
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setOpen(null)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
        );
      })}

      {measuringArea && draft.measurements[measuringArea.id] ? (
        <MeasureSheet
          area={measuringArea}
          measurement={draft.measurements[measuringArea.id]!}
          onChange={(m) => setMeasurement(measuringArea.id, m)}
          onRemove={() => {
            removeMeasurement(measuringArea.id);
            setMeasuring(null);
          }}
          onClose={() => setMeasuring(null)}
        />
      ) : null}

      {lookingUpArea && address ? (
        <RoofLookupSheet
          area={lookingUpArea}
          measurement={draft.measurements[lookingUpArea.id]}
          estimateId={draft.id}
          address={address}
          onApply={(r) => applyRoof(lookingUpArea.id, r)}
          onClose={() => setLookingUp(null)}
          // "Measure by hand" after a failed lookup opens Measure for this area straight away.
          onMeasure={() => {
            if (!draft.measurements[lookingUpArea.id]) setMeasurement(lookingUpArea.id, newMeasurement(lookingUpArea.jobType));
            setLookingUp(null);
            setMeasuring(lookingUpArea.id);
          }}
        />
      ) : null}

      <Card>
        <h2 className="mb-2 font-semibold">Add an area</h2>
        <div className="grid grid-cols-2 gap-2">
          {JOB_TYPES.map((j) => (
            <Button key={j} variant="secondary" className="px-3! whitespace-nowrap" onClick={() => add(j)}>
              + {JOB_TYPE_LABELS[j]}
            </Button>
          ))}
        </div>
      </Card>
    </>
  );
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/** Opens the measuring tools; shows what was measured and whether the square feet still match. */
function MeasureButton({
  measurement,
  sqft,
  onOpen,
  onUseMeasured,
}: {
  measurement: Measurement | undefined;
  sqft: number;
  onOpen: () => void;
  onUseMeasured: (sqft: number) => void;
}) {
  const measured = measurement ? measuredSqft(measurement) : null;
  const differs = measured !== null && Math.round(sqft) !== measured;
  return (
    <div className="space-y-2">
      <DmButton size="lg" block icon={Ruler} onClick={onOpen}>
        {measurement ? 'Edit measurement' : 'Measure this area'}
      </DmButton>
      {measurement ? (
        <p className="text-sm text-slate-600">
          {measurementSummary(measurement)} · {measured === null ? 'not finished' : `${num(measured)} sq ft net`}
        </p>
      ) : (
        <p className="text-xs text-slate-500">Shapes, cutouts, roof pitch and wall heights. Or type the square feet below.</p>
      )}
      {differs ? (
        <Alert tone="amber">
          Square feet ({num(sqft)}) don&apos;t match the measurement ({num(measured)}).{' '}
          <button type="button" className="font-semibold underline" onClick={() => onUseMeasured(measured)}>
            Use {num(measured)}
          </button>
        </Alert>
      ) : null}
    </div>
  );
}

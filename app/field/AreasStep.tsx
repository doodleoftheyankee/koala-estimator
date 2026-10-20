'use client';
import { useState } from 'react';
import { codeMinimumR, JOB_TYPES, ACCESS_LEVELS, type PricingBundle } from '@/lib/pricing';
import { areaSchema, newArea, type AreaDraft, type EstimateDraft } from '@/lib/sync/draft';
import { ACCESS_HINTS, ACCESS_LABELS, JOB_TYPE_LABELS, num } from '@/lib/format';
import { Alert, Badge, Button, Card, Chips, Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import type { Update } from './EstimateEditor';

const EXISTING = ['None', 'Fiberglass batts', 'Blown fiberglass', 'Cellulose', 'Rock wool', 'Vermiculite', 'Spray foam', 'Other'];
const CAVITY_DEPTHS = [
  { value: '3.5', label: '2×4 (3.5")' },
  { value: '5.5', label: '2×6 (5.5")' },
  { value: '7.25', label: '2×8 (7.25")' },
  { value: '9.25', label: '2×10 (9.25")' },
] as const;
const CAVITY_JOBS = new Set(['walls', 'rim_joist', 'crawlspace', 'garage']);

export function AreasStep({ draft, update, bundle }: { draft: EstimateDraft; update: Update; bundle: PricingBundle | null }) {
  const [open, setOpen] = useState<string | null>(draft.areas.at(-1)?.id ?? null);

  const add = (jobType: AreaDraft['jobType']) => {
    const a = newArea(jobType);
    update((d) => ({ ...d, areas: [...d.areas, a] }));
    setOpen(a.id);
  };
  const set = (id: string, patch: Partial<AreaDraft>) =>
    update((d) => ({ ...d, areas: d.areas.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const remove = (id: string) => update((d) => ({ ...d, areas: d.areas.filter((a) => a.id !== id) }));

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
                  {JOB_TYPE_LABELS[a.jobType]} · {a.sqft ? `${num(a.sqft)} sq ft` : 'no size yet'} · R-{a.currentR} → {a.targetR ? `R-${a.targetR}` : codeR ? `code R-${codeR}` : 'code'}
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
                  <div className="flex gap-2">
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

      <Card>
        <h2 className="mb-2 font-semibold">Add an area</h2>
        <div className="grid grid-cols-2 gap-2">
          {JOB_TYPES.map((j) => (
            <Button key={j} variant="secondary" onClick={() => add(j)}>
              + {JOB_TYPE_LABELS[j]}
            </Button>
          ))}
        </div>
      </Card>
    </>
  );
}

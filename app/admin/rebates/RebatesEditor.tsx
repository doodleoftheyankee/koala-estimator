'use client';
// The Rebate programs editor (quiet register): the gauge and defaults, then one plate per program
// with its tiers, cost cap, ventilation rebate, source, effective date and paperwork. The whole
// set is checked as it is typed (the same rules the server applies on save: tiers ascending,
// whole dollars, percentages between 0 and 100, unique names) and saved in one go.
import { useMemo, useState } from 'react';
import { newProgramKey, validateBlowerDoorSettings, type StoredSettings } from '@/lib/blowerdoor';
import { Button, Field, Icon, IconButton, Input, OctagonAlert, Plus, SwitchRow, Textarea, Trash2 } from '@/components/daymark';
import { ActionForm } from '../pricing/ActionForm';
import { saveRebatePrograms } from './actions';

interface DraftTier {
  pct: string;
  rebate: string;
}
interface DraftProgram {
  /** Null for a new program: it gets a key from its short name on save. */
  key: string | null;
  /** Stable React key (never rendered: server and phone count differently). */
  uid: string;
  name: string;
  label: string;
  tiers: DraftTier[];
  costCap: string;
  mechVent: string;
  source: string;
  effective: string;
  /** One item per line. */
  paperwork: string;
  paperworkSource: string;
}
interface Draft {
  gauge: string;
  exponent: string;
  nFactor: string;
  wholeCfm50: boolean;
  programs: DraftProgram[];
}

const text = (n: number | null) => (n === null ? '' : String(n));
let uidSeq = 0;
const uid = () => `p${++uidSeq}`;

function toDraft(s: StoredSettings): Draft {
  return {
    gauge: s.gauge,
    exponent: text(s.flow_exponent),
    nFactor: text(s.n_factor),
    wholeCfm50: s.whole_cfm50 === true,
    programs: s.programs.map((p) => ({
      key: p.key,
      uid: uid(),
      name: p.name,
      label: p.label,
      tiers: p.tiers.map((t) => ({ pct: text(t.reduction_pct), rebate: text(t.rebate) })),
      costCap: text(p.cost_cap_pct),
      mechVent: text(p.mech_vent_rebate_cap),
      source: p.source,
      effective: p.effective_date ?? '',
      paperwork: p.paperwork.join('\n'),
      paperworkSource: p.paperwork_source,
    })),
  };
}

/** A typed number ("$" and commas dropped), "" → null; anything else stays text, so the check names it. */
function number(s: string): number | null | string {
  const t = s.replace(/[$,%\s]/g, '');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : s;
}

/** The draft as the stored JSON (the server checks it again before saving). */
function fromDraft(d: Draft): unknown {
  const taken = d.programs.map((p) => p.key).filter((k): k is string => !!k);
  return {
    gauge: d.gauge,
    flow_exponent: number(d.exponent),
    n_factor: number(d.nFactor),
    whole_cfm50: d.wholeCfm50,
    programs: d.programs.map((p) => {
      const key = p.key ?? newProgramKey(p.label, taken);
      if (!p.key) taken.push(key);
      return {
        key,
        name: p.name,
        label: p.label,
        tiers: p.tiers.map((t) => ({ reduction_pct: number(t.pct), rebate: number(t.rebate) })),
        cost_cap_pct: number(p.costCap),
        mech_vent_rebate_cap: number(p.mechVent),
        source: p.source,
        effective_date: p.effective.trim() || null,
        paperwork: p.paperwork
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        paperwork_source: p.paperworkSource,
      };
    }),
  };
}

const NEW_PROGRAM = (): DraftProgram => ({
  key: null,
  uid: uid(),
  name: '',
  label: '',
  tiers: [{ pct: '', rebate: '' }],
  costCap: '',
  mechVent: '',
  source: '',
  effective: '',
  paperwork: '',
  paperworkSource: '',
});

export function RebatesEditor({ initial, readOnly }: { initial: StoredSettings; readOnly: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [touched, setTouched] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const submit = useMemo(() => fromDraft(draft), [draft]);
  const check = useMemo(() => validateBlowerDoorSettings(submit), [submit]);

  const edit = (fn: (d: Draft) => Draft) => {
    setDraft(fn);
    setTouched(true);
  };
  const editProgram = (i: number, patch: Partial<DraftProgram>) => edit((d) => ({ ...d, programs: d.programs.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const editTier = (i: number, t: number, patch: Partial<DraftTier>) =>
    edit((d) => ({ ...d, programs: d.programs.map((p, j) => (j === i ? { ...p, tiers: p.tiers.map((x, k) => (k === t ? { ...x, ...patch } : x)) } : p)) }));

  return (
    <ActionForm action={saveRebatePrograms} readOnly={readOnly} submitLabel="Save rebate programs" className="space-y-5">
      <input type="hidden" name="settings" value={JSON.stringify(submit)} />

      <section aria-labelledby="rb-gauge" className="plate p-4 md:p-5">
        <h2 id="rb-gauge" className="text-[19px] font-extrabold text-ink">
          Gauge and defaults
        </h2>
        <p className="mt-1 text-[15.5px] font-medium text-ink-2">Named in the copied summary. The tool starts each new test with these; the person testing can change them.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Field label="Gauge" hint="The blower door gauge your crews test with">
            <Input value={draft.gauge} onChange={(e) => edit((d) => ({ ...d, gauge: e.target.value }))} maxLength={80} />
          </Field>
          <Field label="Default flow exponent (n)" hint="The gauge's house setting, 0.5 to 1.0">
            <Input value={draft.exponent} onChange={(e) => edit((d) => ({ ...d, exponent: e.target.value }))} inputMode="decimal" />
          </Field>
          <Field label="Default zone N-factor" hint="For the BAS estimate: the zone's 1-story value (the tool corrects for the stories); match your audit software">
            <Input value={draft.nFactor} onChange={(e) => edit((d) => ({ ...d, nFactor: e.target.value }))} inputMode="decimal" />
          </Field>
        </div>
        <SwitchRow
          className="mt-4"
          checked={draft.wholeCfm50}
          onChange={(v) => edit((d) => ({ ...d, wholeCfm50: v }))}
          disabled={readOnly}
          label="Decide on whole-number CFM50"
          hint="On: the tier and the ventilation check use each CFM50 rounded to a whole number, as the gauge's @50 screen and a test-out form show it. Off: the exact converted CFM50. Ask your program which one it uses."
        />
      </section>

      {draft.programs.map((p, i) => {
        const title = p.label.trim() || `Program ${i + 1}`;
        return (
          <section key={p.uid} aria-label={`Program: ${title}`} className="plate p-4 md:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[19px] font-extrabold text-ink">{title}</h2>
              {readOnly ? null : removing === p.uid ? (
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      edit((d) => ({ ...d, programs: d.programs.filter((x) => x.uid !== p.uid) }));
                      setRemoving(null);
                    }}
                  >
                    Yes, remove {title}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                    Keep it
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="danger" icon={Trash2} onClick={() => setRemoving(p.uid)}>
                  Remove program
                </Button>
              )}
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Short name" hint="On the program buttons in the tool">
                <Input value={p.label} onChange={(e) => editProgram(i, { label: e.target.value })} maxLength={40} />
              </Field>
              <Field label="Full name" hint="In the copied summary">
                <Input value={p.name} onChange={(e) => editProgram(i, { name: e.target.value })} maxLength={120} />
              </Field>
            </div>

            <fieldset className="mt-5 min-w-0">
              <legend className="text-[16px] font-bold text-ink">Tiers</legend>
              <p className="text-[15px] font-medium text-ink-2">Lowest reduction first. A tier is reached when the test-out CFM50 is at least this much below the test-in.</p>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3rem] items-end gap-x-3 gap-y-2 md:max-w-xl">
                <span className="text-[15px] font-bold text-ink-2" id={`rb-${i}-pct`}>
                  Reduction (%)
                </span>
                <span className="text-[15px] font-bold text-ink-2" id={`rb-${i}-reb`}>
                  Rebate ($, whole dollars)
                </span>
                <span />
                {p.tiers.map((t, k) => (
                  <TierRow
                    key={k}
                    tier={t}
                    pctLabel={`rb-${i}-pct`}
                    rebateLabel={`rb-${i}-reb`}
                    onPct={(v) => editTier(i, k, { pct: v })}
                    onRebate={(v) => editTier(i, k, { rebate: v })}
                    onRemove={p.tiers.length > 1 && !readOnly ? () => editProgram(i, { tiers: p.tiers.filter((_, x) => x !== k) }) : null}
                    removeLabel={`Remove the ${t.pct || 'new'}% tier`}
                  />
                ))}
              </div>
              {readOnly ? null : (
                <Button size="sm" icon={Plus} className="mt-2" onClick={() => editProgram(i, { tiers: [...p.tiers, { pct: '', rebate: '' }] })}>
                  Add tier
                </Button>
              )}
            </fieldset>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Field label="Cost cap (%)" hint="The rebate is at most this share of the installed air sealing price. Empty: no cap.">
                <Input value={p.costCap} onChange={(e) => editProgram(i, { costCap: e.target.value })} inputMode="decimal" />
              </Field>
              <Field label="Mechanical ventilation rebate, up to ($)" hint="Named when the tool says ventilation is needed. Empty: none.">
                <Input value={p.mechVent} onChange={(e) => editProgram(i, { mechVent: e.target.value })} inputMode="numeric" />
              </Field>
              <Field label="Source of the tier amounts" hint="The program's rebate schedule">
                <Input value={p.source} onChange={(e) => editProgram(i, { source: e.target.value })} maxLength={200} />
              </Field>
              <Field label="Effective date">
                <Input type="date" value={p.effective} onChange={(e) => editProgram(i, { effective: e.target.value })} />
              </Field>
              <Field label="Test-out paperwork" hint="One item per line. Shown as a checklist under the result." className="md:col-span-2">
                <Textarea rows={5} value={p.paperwork} onChange={(e) => editProgram(i, { paperwork: e.target.value })} />
              </Field>
              <Field label="Source of the paperwork list" hint="The program's manual" className="md:col-span-2">
                <Input value={p.paperworkSource} onChange={(e) => editProgram(i, { paperworkSource: e.target.value })} maxLength={200} />
              </Field>
            </div>
          </section>
        );
      })}

      {draft.programs.length === 0 ? (
        <p className="plate p-4 text-[16px] font-medium text-ink-2">
          No programs. The blower door tool still converts the readings and checks ventilation, and says no rebate program is set up.
        </p>
      ) : null}

      {readOnly ? null : (
        <Button icon={Plus} onClick={() => edit((d) => ({ ...d, programs: [...d.programs, NEW_PROGRAM()] }))}>
          Add program
        </Button>
      )}

      {touched && !check.ok ? (
        <div role="status" className="rounded-control border-solid border-[length:var(--bw)] border-bad bg-bad-fill px-3.5 py-3">
          <p className="flex items-center gap-2 font-extrabold text-bad">
            <Icon icon={OctagonAlert} size="s" />
            Fix these before saving
          </p>
          <ul className="mt-1 list-disc pl-6 text-[15.5px] font-medium text-ink">
            {check.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </ActionForm>
  );
}

function TierRow({
  tier,
  pctLabel,
  rebateLabel,
  onPct,
  onRebate,
  onRemove,
  removeLabel,
}: {
  tier: DraftTier;
  pctLabel: string;
  rebateLabel: string;
  onPct: (v: string) => void;
  onRebate: (v: string) => void;
  onRemove: (() => void) | null;
  removeLabel: string;
}) {
  return (
    <>
      <Input aria-labelledby={pctLabel} value={tier.pct} onChange={(e) => onPct(e.target.value)} inputMode="decimal" />
      <Input aria-labelledby={rebateLabel} value={tier.rebate} onChange={(e) => onRebate(e.target.value)} inputMode="numeric" />
      {onRemove ? <IconButton icon={Trash2} label={removeLabel} variant="ghost" onClick={onRemove} /> : <span />}
    </>
  );
}

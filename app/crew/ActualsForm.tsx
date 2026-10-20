'use client';
// What the crew actually used and spent, per area x product in the signed scope, plus the
// job-level row. Estimates appear as placeholders. Never shows prices or costs.
import { naturalKey, PRODUCT_LABELS, UNIT_LABELS, type CrewJob } from '@/lib/jobs/crew';
import type { LocalActuals } from '@/lib/offline/crewDb';
import { expectedRows, missingFor, type ExpectedRow, type RowValues } from '@/lib/offline/crewSyncCore';
import { num } from '@/lib/format';
import { Card, Field, Input, Textarea } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';

const EMPTY: RowValues = { materialQty: null, hours: null, crewSize: null, driveMinutes: null, days: null, notes: null };

export function ActualsForm({
  job,
  draft,
  values,
  setRow,
}: {
  job: CrewJob;
  draft: LocalActuals;
  values: Record<string, RowValues>;
  setRow: (key: string, patch: Partial<RowValues>) => void;
}) {
  const locked = draft.syncState === 'locked';
  const expected = expectedRows(job);
  const known = new Set(expected.map((e) => e.key));
  // Rows beyond the signed scope (entered by the office, or an older scope): still editable.
  const extras: ExpectedRow[] = draft.rows
    .filter((r) => !known.has(naturalKey(r.areaId, r.product)) && r.areaId !== null && r.product !== null)
    .map((r) => ({
      key: naturalKey(r.areaId, r.product),
      areaId: r.areaId,
      areaName: job.areas.find((a) => a.areaId === r.areaId)?.name ?? 'Other area',
      product: r.product,
      label: r.product ? PRODUCT_LABELS[r.product] : 'Other',
      unit: r.materialUnit,
      estQty: null,
      estHours: null,
      needsQty: r.materialUnit !== null,
    }));
  const areaRows = [...expected, ...extras].filter((e) => e.areaId !== null);
  const jobRow = expected.find((e) => e.areaId === null)!;
  const areaIds = [...new Set(areaRows.map((e) => e.areaId!))];

  return (
    <fieldset disabled={locked} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <legend className="sr-only">Job actuals</legend>
      {areaIds.map((areaId) => (
        <Card key={areaId}>
          <h3 className="mb-3 font-semibold text-slate-900">{areaRows.find((e) => e.areaId === areaId)?.areaName}</h3>
          <div className="space-y-4">
            {areaRows
              .filter((e) => e.areaId === areaId)
              .map((e) => (
                <ScopeRow key={e.key} row={e} value={values[e.key] ?? EMPTY} onChange={(patch) => setRow(e.key, patch)} />
              ))}
          </div>
        </Card>
      ))}

      <Card>
        <h3 className="mb-1 font-semibold text-slate-900">Whole job</h3>
        <p className="mb-3 text-sm text-slate-600">Averages for the whole job, all days.</p>
        <JobRow value={values[jobRow.key] ?? EMPTY} missing={missingFor(jobRow, values[jobRow.key])} onChange={(patch) => setRow(jobRow.key, patch)} />
      </Card>
    </fieldset>
  );
}

function ScopeRow({ row, value, onChange }: { row: ExpectedRow; value: RowValues; onChange: (patch: Partial<RowValues>) => void }) {
  const unit = row.unit ? UNIT_LABELS[row.unit] : 'units';
  const missing = missingFor(row, value);
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium text-slate-800">{row.label}</p>
        {missing.length === 0 ? <span className="text-xs font-semibold text-emerald-700">Done</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {row.needsQty ? (
          <Field label={`${capitalize(unit)} used`} hint={row.estQty !== null ? `Estimate ${num(row.estQty, 1)}` : undefined}>
            <NumberInput value={value.materialQty} onValue={(n) => onChange({ materialQty: n })} placeholder={row.estQty !== null ? num(row.estQty, 1) : undefined} />
          </Field>
        ) : null}
        <Field
          label={row.product === 'removal' ? 'Removal person-hours' : 'Person-hours'}
          hint={row.estHours !== null ? `Estimate ${num(row.estHours, 1)} (all people)` : 'All people combined'}
          className={row.needsQty ? undefined : 'col-span-2 sm:col-span-1'}
        >
          <NumberInput value={value.hours} onValue={(n) => onChange({ hours: n })} placeholder={row.estHours !== null ? num(row.estHours, 1) : undefined} />
        </Field>
      </div>
      <Field label="Note (optional)">
        <Input value={value.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value || null })} placeholder="e.g. two extra bags for the knee walls" maxLength={2000} />
      </Field>
    </div>
  );
}

function JobRow({ value, missing, onChange }: { value: RowValues; missing: string[]; onChange: (patch: Partial<RowValues>) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Drive, one way (min)" hint="Average per day" className="col-span-2 sm:col-span-1">
          <NumberInput value={value.driveMinutes} onValue={(n) => onChange({ driveMinutes: n })} />
        </Field>
        <Field label="Days on site">
          <NumberInput value={value.days} onValue={(n) => onChange({ days: n })} />
        </Field>
        <Field label="Crew size">
          <NumberInput value={value.crewSize} onValue={(n) => onChange({ crewSize: n })} allowDecimal={false} />
        </Field>
      </div>
      <Field label="Notes for the office (optional)">
        <Textarea rows={3} value={value.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value || null })} placeholder="Anything that made this job harder or easier than planned" maxLength={2000} />
      </Field>
      {missing.length ? <p className="text-xs text-slate-500">Needed to complete the job: {missing.join(', ')}.</p> : null}
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

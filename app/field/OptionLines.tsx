'use client';
import { useState } from 'react';
import type { DeviationFlag } from '@/lib/learning/types';
import type { LineOverride, PricedLine, Tier } from '@/lib/pricing';
import { ackNote } from '@/lib/field/flags';
import { buildLineOverride, formatAmount, formatPctDiff, lineView, relativeDiff, unitLabel, type LineView } from '@/lib/field/lineOverrides';
import { TIER_LABELS, usd } from '@/lib/format';
import { Button, Field, Input, cx } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import { DeviationNote } from './DeviationNote';

export type OnLineOverride = (key: string, override: LineOverride | null) => void;

/**
 * The "Details" of one option: every line with the model's quantity or hours next to the
 * estimator's. Area lines can be changed (with a reason); the change is stored once per line key
 * and so applies to every option with that line. Job-level lines (travel, disposal) follow
 * from the drive time and areas and are not editable here.
 */
export function OptionLines({
  lines,
  areaNames,
  tiersByKey,
  flagsByLine,
  acks,
  onAck,
  onLineOverride,
  showCosts,
}: {
  lines: PricedLine[];
  areaNames: Map<string, string>;
  tiersByKey: (key: string) => Tier[];
  flagsByLine: Map<string, DeviationFlag[]>;
  acks: Record<string, string>;
  onAck: (key: string, note: string) => void;
  onLineOverride: OnLineOverride;
  showCosts: boolean;
}) {
  return (
    <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3">
      {groupLines(lines, areaNames).map((g) => (
        <div key={g.id}>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{g.title}</p>
          <ul className="divide-y divide-slate-200">
            {g.lines.map((line, i) => (
              <LineRow
                key={line.key ?? `${line.kind}-${i}`}
                line={line}
                tiers={line.key ? tiersByKey(line.key) : []}
                flags={(line.key && flagsByLine.get(line.key)) || []}
                acks={acks}
                onAck={onAck}
                onLineOverride={onLineOverride}
                showCosts={showCosts}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Area lines grouped by area (in priced order), then the job-level lines. */
function groupLines(lines: PricedLine[], areaNames: Map<string, string>): Array<{ id: string; title: string; lines: PricedLine[] }> {
  const groups = new Map<string, { id: string; title: string; lines: PricedLine[] }>();
  for (const l of lines) {
    const id = l.areaId ?? '__job';
    let g = groups.get(id);
    if (!g) {
      g = { id, title: l.areaId ? (areaNames.get(l.areaId) ?? 'Area') : 'Whole job', lines: [] };
      groups.set(id, g);
    }
    g.lines.push(l);
  }
  const job = groups.get('__job');
  groups.delete('__job');
  return job ? [...groups.values(), job] : [...groups.values()];
}

function LineRow({
  line,
  tiers,
  flags,
  acks,
  onAck,
  onLineOverride,
  showCosts,
}: {
  line: PricedLine;
  tiers: Tier[];
  flags: DeviationFlag[];
  acks: Record<string, string>;
  onAck: (key: string, note: string) => void;
  onLineOverride: OnLineOverride;
  showCosts: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const view = lineView(line);

  if (!view) {
    return (
      <li className="flex justify-between gap-3 py-2 text-sm">
        <span className="text-slate-700">{line.description}</span>
        {showCosts ? <span className="shrink-0 text-slate-500">{usd(line.cost)}</span> : null}
      </li>
    );
  }

  return (
    <li className="py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-slate-800">{line.description}</p>
          {view.isOverridden ? (
            <p className="text-slate-700">
              Model {formatAmount(view.modelValue, view.unit)} · yours <span className="font-semibold">{formatAmount(view.value, view.unit)}</span>{' '}
              <span className={cx('font-semibold', view.pctDiff !== null && view.pctDiff !== 0 ? 'text-amber-800' : 'text-slate-500')}>
                ({formatPctDiff(view.pctDiff)})
              </span>
            </p>
          ) : (
            <p className="text-slate-600">
              {formatAmount(view.value, view.unit)} <span className="text-slate-500">(model)</span>
            </p>
          )}
          {view.isOverridden && view.reason ? <p className="text-xs text-slate-500">Reason: {view.reason}</p> : null}
          {showCosts ? (
            <p className="text-xs text-slate-500">
              Cost {usd(line.cost)}
              {view.isOverridden ? ` (model ${usd(line.modelCost)})` : ''}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={editing ? 'secondary' : 'ghost'}
          onClick={() => setEditing((e) => !e)}
          aria-expanded={editing}
          aria-label={`${editing ? 'Close' : 'Change'} ${line.description}`}
        >
          {editing ? 'Close' : 'Change'}
        </Button>
      </div>

      {editing ? (
        <LineEditor
          view={view}
          tiers={tiers}
          onApply={(ov) => {
            onLineOverride(view.key, ov);
            setEditing(false);
          }}
          onReset={() => {
            onLineOverride(view.key, null);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : null}

      {flags.map((f) => (
        <div key={f.key} className="mt-2">
          <DeviationNote flag={f} note={ackNote(acks, f.key)} onNote={(note) => onAck(f.key, note)} />
        </div>
      ))}
    </li>
  );
}

function LineEditor({
  view,
  tiers,
  onApply,
  onReset,
  onCancel,
}: {
  view: LineView;
  tiers: Tier[];
  onApply: (o: LineOverride) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<number | null>(view.value);
  const [reason, setReason] = useState(view.reason ?? '');
  const built = buildLineOverride(view.metric, value, reason);
  const diff = value === null ? null : relativeDiff(value, view.modelValue);
  const where = tiers.length > 1 ? ` (${tiers.map((t) => TIER_LABELS[t]).join(', ')})` : '';

  return (
    <div className="mt-2 space-y-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <Field
        label={view.metric === 'qty' ? `Quantity (${unitLabel(view.unit)})` : 'Person-hours'}
        hint={
          <>
            Model: {formatAmount(view.modelValue, view.unit)}
            {diff !== null && diff !== 0 ? ` · yours is ${formatPctDiff(diff)}` : ''}
            {view.metric === 'hours' ? '. Total for the whole crew (2 people × 5 h = 10).' : ''}
          </>
        }
      >
        <NumberInput value={value} onValue={setValue} />
      </Field>
      <Field label="Reason (required)">
        <Input
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder={view.metric === 'qty' ? 'e.g. deep joist bays need more' : 'e.g. low clearance, long hose run'}
        />
      </Field>
      <p className="text-xs text-slate-600">Applies to every option with this line{where}.</p>
      {!built.ok ? <p className="text-xs text-amber-800">{built.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!built.ok} onClick={() => built.ok && onApply(built.override)}>
          Apply
        </Button>
        {view.isOverridden ? (
          <Button size="sm" variant="secondary" onClick={onReset}>
            Use model value
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

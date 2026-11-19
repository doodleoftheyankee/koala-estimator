'use client';
// The blower door tool's parts, in the Daymark field register: the result plate (the big gauge,
// the tier in words, the bar with a tick per tier), a test card (a saved reading as recorded, or
// the two gauge fields), the tier table, the numbers list and the paperwork. Words come from
// lib/blowerdoor/words.ts; nothing here types a number or a program.
import type { ReactNode } from 'react';
import {
  achText,
  cfmText,
  formatEffectiveDate,
  headlineWords,
  KIND_LABELS,
  nextTierLine,
  paText,
  pctText,
  type Evaluation,
  type SavedTest,
  type TestKind,
  type TestResult,
} from '@/lib/blowerdoor';
import type { LocalTest } from '@/lib/offline/blowerDoorCore';
import { formatMoney, formatShortDateTime, num } from '@/lib/format';
import {
  Button,
  Check,
  CircleCheck,
  ClipboardCheck,
  CloudCheck,
  CloudUpload,
  cx,
  Field,
  Icon,
  Input,
  OctagonAlert,
  RefreshCw,
  SignLabel,
  Tag,
  TriangleAlert,
  Undo2,
  type ButtonVariant,
} from '@/components/daymark';

// ---------------------------------------------------------------------------------------------
// The result plate
// ---------------------------------------------------------------------------------------------

const TONE = {
  pass: { plate: 'border-ok bg-ok-fill', badge: 'text-ok', icon: CircleCheck },
  fail: { plate: 'border-bad bg-bad-fill', badge: 'text-bad', icon: OctagonAlert },
  neutral: { plate: 'border-edge bg-surface', badge: 'text-ink-2', icon: null },
} as const;

export function ResultPlate({ e }: { e: Evaluation }) {
  const w = headlineWords(e);
  const t = TONE[w.tone];
  const ticks = e.program ? e.program.tiers.map((x) => x.reductionPct) : [];
  return (
    <section aria-label="Result" className={cx('rounded-plate border-solid border-[length:var(--bw-go)] p-4 text-center', t.plate)}>
      <p className={cx('flex items-center justify-center gap-2 sign-label [--sign-size:13.5px]', t.badge)} data-testid="bd-badge">
        {t.icon ? <Icon icon={t.icon} size="s" /> : null}
        <span>{w.badge}</span>
      </p>
      <p className="gauge mt-2 text-[76px] text-ink" data-testid="bd-big">
        {w.big}
      </p>
      {w.unit ? <SignLabel tone="ink" className="mt-1">{w.unit}</SignLabel> : null}
      <p className="mt-2 text-[17px] leading-snug font-bold text-ink">{w.line}</p>
      {e.reductionPct !== null && ticks.length ? <ReductionBar pct={e.reductionPct} ticks={ticks} /> : null}
    </section>
  );
}

/**
 * The reduction on a bar that runs from 0 to 20 points past the top tier (60% for a 40% top
 * tier), so the tier ticks and their labels have room on a phone; a bigger reduction fills it.
 */
function ReductionBar({ pct, ticks }: { pct: number; ticks: number[] }) {
  const max = Math.max(50, Math.ceil((Math.max(...ticks) + 20) / 10) * 10);
  const at = (v: number) => `${(Math.max(0, Math.min(max, v)) / max) * 100}%`;
  return (
    <div className="relative mx-1 mt-5 mb-1" aria-hidden>
      <div className="relative h-4 overflow-hidden rounded-full bg-track shadow-[inset_0_0_0_2px_var(--track-edge)]">
        <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: at(pct) }} />
      </div>
      {ticks.map((t) => (
        <span key={t} className="absolute -top-1.5 h-7 w-[3px] -translate-x-1/2 rounded-sm bg-ink shadow-[0_0_0_2px_var(--surface)]" style={{ left: at(t) }} />
      ))}
      <div className="relative mt-2 h-5">
        {ticks.map((t) => (
          <span key={t} className="gauge-m absolute -translate-x-1/2 text-[16px] text-ink" style={{ left: at(t) }}>
            {num(t)}%
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A test card
// ---------------------------------------------------------------------------------------------

/** A saved reading's state on the phone, in words. */
function SavedTag({ local, online, where }: { local: LocalTest | null; online: boolean; where: 'job' | 'estimate' }) {
  if (!local || local.syncState === 'synced') {
    return (
      <Tag tone="ok" icon={CloudCheck}>
        Saved to the {where}
      </Tag>
    );
  }
  if (local.syncState === 'invalid') {
    return (
      <Tag tone="bad" icon={OctagonAlert}>
        Not saved
      </Tag>
    );
  }
  if (local.syncState === 'waiting') {
    return (
      <Tag tone="warn" icon={CloudUpload}>
        Waiting for the estimate
      </Tag>
    );
  }
  return (
    <Tag tone="warn" icon={online ? RefreshCw : CloudUpload}>
      {online ? 'Syncing' : 'On this phone'}
    </Tag>
  );
}

/** One gauge field: big tabular numbers, 56px tall, the decimal keypad. */
function GaugeField({ label, value, onChange, error, hint, name }: { label: string; value: string; onChange: (v: string) => void; error: string | null; hint?: ReactNode; name: string }) {
  return (
    <Field label={label} error={error} hint={hint}>
      <Input
        name={name}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        inputMode="decimal"
        autoComplete="off"
        enterKeyHint="next"
        aria-invalid={error ? true : undefined}
        className="gauge-m min-h-16 text-[32px]"
      />
    </Field>
  );
}

export interface TestCardProps {
  kind: TestKind;
  /** The reading shown as recorded (null: the typed fields). */
  saved: { test: SavedTest; local: LocalTest | null } | null;
  result: TestResult;
  cfm: string;
  pa: string;
  onCfm: (v: string) => void;
  onPa: (v: string) => void;
  /** A hint under the fields (the test-out's gauge tip). */
  hint?: ReactNode;
  /** Saving is offered (the tool was opened from a job or an estimate). */
  canSave: boolean;
  saveVariant: ButtonVariant;
  onSave: () => void;
  onRetake: () => void;
  /** Retaking over a saved reading: go back to it. */
  onCancelRetake: (() => void) | null;
  online: boolean;
}

export function TestCard(p: TestCardProps) {
  const label = KIND_LABELS[p.kind];
  const id = `bd-${p.kind}`;
  const after = p.kind === 'test_out';
  return (
    <section aria-labelledby={id} className="plate p-4">
      <h2 id={id} className="flex flex-wrap items-center justify-between gap-2">
        <span className="sign-label text-ink [--sign-size:14px]">
          {label} ({after ? 'after' : 'before'})
        </span>
        {p.saved ? <SavedTag local={p.saved.local} online={p.online} where={p.saved.test.job_id ? 'job' : 'estimate'} /> : null}
      </h2>

      {p.saved ? (
        <div className="mt-3 space-y-2">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="gauge text-[56px] text-ink" data-testid={`${id}-cfm50`}>
              {cfmText(p.saved.test.cfm50)}
            </span>
            <SignLabel tone="ink">CFM50</SignLabel>
          </p>
          <p className="text-[16px] leading-snug font-semibold text-ink-2">
            Read {cfmText(p.saved.test.cfm)} CFM at {paText(p.saved.test.pa)} Pa · n {num(p.saved.test.exponent, 3)}
          </p>
          <p className="text-[15.5px] leading-snug font-medium text-ink-2">
            Recorded {formatShortDateTime(p.saved.test.recorded_at)}
            {p.saved.test.recorded_by_name ? ` by ${p.saved.test.recorded_by_name}` : ''}
          </p>
          {p.saved.local?.lastError && p.saved.local.syncState !== 'synced' ? (
            <p className={cx('flex items-start gap-2 text-[15.5px] leading-snug font-bold', p.saved.local.syncState === 'invalid' ? 'text-bad' : 'text-warn')}>
              <Icon icon={p.saved.local.syncState === 'invalid' ? OctagonAlert : TriangleAlert} size="s" className="mt-0.5" />
              <span>{p.saved.local.lastError}</span>
            </p>
          ) : null}
          {p.result.lowPressure ? <LowPressure /> : null}
          <Button size="sm" icon={RefreshCw} onClick={p.onRetake} className="mt-1">
            Retake {label.toLowerCase()}
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <GaugeField name={`${p.kind}-cfm`} label="Fan flow (CFM)" value={p.cfm} onChange={p.onCfm} error={p.result.cfmError} />
            <GaugeField name={`${p.kind}-pa`} label="House pressure (Pa)" value={p.pa} onChange={p.onPa} error={p.result.paError} />
          </div>
          {p.hint ? <p className="text-[15px] leading-snug font-medium text-ink-2">{p.hint}</p> : null}
          {p.result.reading ? (
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="gauge-m text-[30px] text-ink" data-testid={`${id}-cfm50`}>
                {cfmText(p.result.reading.cfm50)}
              </span>
              <SignLabel tone="ink">CFM50</SignLabel>
            </p>
          ) : null}
          {p.result.lowPressure ? <LowPressure /> : null}
          {p.canSave || p.onCancelRetake ? (
            <div className="flex flex-wrap gap-2">
              {p.canSave ? (
                <Button variant={p.result.reading ? p.saveVariant : 'secondary'} icon={Check} disabled={!p.result.reading} onClick={p.onSave} className="min-w-0 flex-1">
                  Save {label.toLowerCase()}
                </Button>
              ) : null}
              {p.onCancelRetake ? (
                <Button variant="ghost" icon={Undo2} onClick={p.onCancelRetake}>
                  Keep the saved one
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function LowPressure() {
  return (
    <p className="flex items-start gap-2 text-[15.5px] leading-snug font-semibold text-warn">
      <Icon icon={TriangleAlert} size="s" className="mt-0.5" />
      <span>Far from 50 Pa, so the CFM50 is stretched a long way. Test nearer 50 Pa if the fan can reach it.</span>
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Tiers, numbers, paperwork
// ---------------------------------------------------------------------------------------------

export function TierTable({ e }: { e: Evaluation }) {
  if (!e.program) return null;
  const rows = e.tiers?.rows ?? e.program.tiers.map((tier) => ({ tier, limit: null as number | null, reached: false }));
  const line = nextTierLine(e.tiers, e.testOut.reading !== null);
  return (
    <section aria-labelledby="bd-tiers" className="plate p-4">
      <h2 id="bd-tiers" className="sign-label text-ink [--sign-size:14px]">
        Rebate tiers · {e.program.label}
      </h2>
      <table className="mt-2 w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="py-2 text-[15px] font-bold text-ink-2">Tier</th>
            <th scope="col" className="py-2 text-right text-[15px] font-bold text-ink-2">CFM50 at or below</th>
            <th scope="col" className="py-2 pl-3 text-right text-[15px] font-bold text-ink-2">Rebate cap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tier.reductionPct} className="border-b border-line last:border-b-0" data-reached={r.reached || undefined}>
              <td className={cx('py-2.5 text-[17px]', r.reached ? 'font-extrabold text-ink' : 'font-semibold text-ink-2')}>
                <span className="inline-flex items-center gap-1.5">
                  {r.reached ? <Icon icon={Check} size="s" label="Reached" /> : null}
                  {num(r.tier.reductionPct, 1)}%
                </span>
              </td>
              <td className={cx('gauge-m py-2.5 text-right text-[22px]', r.reached ? 'text-ink' : 'text-ink-2')}>{r.limit === null ? '—' : cfmText(r.limit)}</td>
              <td className={cx('gauge-m py-2.5 pl-3 text-right text-[22px]', r.reached ? 'text-ink' : 'text-ink-2')}>{formatMoney(r.tier.rebate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {line ? <p className="mt-2 text-[16px] leading-snug font-bold text-ink">{line}</p> : null}
    </section>
  );
}

export function NumbersList({ e, capLabel }: { e: Evaluation; capLabel: string | null }) {
  const pre = e.testIn.reading;
  const post = e.testOut.reading;
  const rows: Array<[string, string]> = [
    ['Before CFM50', pre ? cfmText(pre.cfm50) : '—'],
    ['After CFM50', post ? cfmText(post.cfm50) : '—'],
    ['CFM50 removed', e.removed !== null ? cfmText(e.removed) : '—'],
    ['Reduction from raw gauge readings', e.rawReductionPct !== null ? pctText(e.rawReductionPct) : '—'],
  ];
  if (e.program) rows.push(['Rebate (tier)', e.rebate ? (e.tiers?.hit ? `${formatMoney(e.rebate.tierAmount)} (${num(e.tiers.hit.reductionPct, 1)}%)` : formatMoney(0)) : '—']);
  if (capLabel && e.rebate?.cap != null && e.tiers?.hit) rows.push([capLabel, formatMoney(e.rebate.amount)]);
  if (e.bas.value !== null) rows.push(['BAS (minimum CFM50)', `${cfmText(e.bas.value)} (${e.bas.source === 'audit' ? 'from audit' : 'estimated'})`]);
  if (e.ach50Pre !== null) rows.push(['ACH50 before', achText(e.ach50Pre)]);
  if (e.ach50Post !== null) rows.push(['ACH50 after', achText(e.ach50Post)]);
  return (
    <section aria-labelledby="bd-numbers" className="plate p-4">
      <h2 id="bd-numbers" className="sign-label text-ink [--sign-size:14px]">
        Numbers
      </h2>
      <dl className="mt-1 divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 py-2.5">
            <dt className="text-[16px] leading-snug font-semibold text-ink-2">{k}</dt>
            <dd className="gauge-m shrink-0 text-right text-[22px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Paperwork({ items, source }: { items: string[]; source: string }) {
  return (
    <section aria-labelledby="bd-paperwork" className="plate p-4">
      <h2 id="bd-paperwork" className="flex items-center gap-2 sign-label text-ink [--sign-size:14px]">
        <Icon icon={ClipboardCheck} size="s" />
        Test-out paperwork
      </h2>
      {items.length ? (
        <ul className="mt-3 space-y-2">
          {items.map((t) => (
            <li key={t} className="flex items-start gap-2.5 text-[16px] leading-snug font-semibold text-ink">
              <span aria-hidden className="mt-[3px] h-4 w-4 shrink-0 rounded-[4px] border-solid border-[length:var(--bw)] border-edge" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[15px] leading-snug font-medium text-ink-2">{source}</p>
    </section>
  );
}

/** "effective Nov 1, 2024" under the program buttons. */
export function effectiveLine(date: string | null): string | null {
  const d = formatEffectiveDate(date);
  return d ? `Tier amounts effective ${d}.` : null;
}

// Parts for the office lists (/estimates, /jobs) in the quiet register: a strip of figures that
// count the rows below them, filter chips that are links (so the URL keeps the filter and the
// page needs no script to filter), and the classes of a hairline table.
//
//   <KpiStrip title="Figures for this list" note="Counts the 12 estimates below."
//     items={[{ key: 'waiting', label: 'Waiting to sign', value: formatMoney(t), detail: '4 quotes, sent or viewed' }]} />
//   <FilterChips label="Status" items={[{ key: 'all', href: '/estimates', label: 'All', current: true }]} />
//   <table className={TABLE.table}>…<tr className={TABLE.headRow}><th className={TABLE.th}>…
//
// Server components (no hooks). Figures are formatted by the page with lib/format.ts; nothing
// here types a number.
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '@/components/daymark/cx';
import { Check, Icon } from '@/components/daymark/icons';

export interface KpiItem {
  key: string;
  /** What is counted, as a sign label: "Waiting to sign". */
  label: string;
  /** The formatted figure: "$21,640" or "4". */
  value: ReactNode;
  /** Exactly what the figure counts: "4 quotes, sent or viewed". */
  detail: ReactNode;
}

/** A plate of figures, divided by hairlines: two across on phones, one row on wider screens. */
export function KpiStrip({ title, items, note, className }: { title: string; items: readonly KpiItem[]; note?: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cx('space-y-2', className)}>
      <dl
        className={cx(
          'grid grid-cols-2 gap-px overflow-hidden rounded-plate border-solid border-[length:var(--bw)] border-edge bg-line',
          items.length >= 4 ? '@3xl:grid-cols-4' : '@3xl:grid-cols-3',
        )}
      >
        {items.map((k) => (
          <div key={k.key} className="flex min-w-0 flex-col gap-2 bg-surface px-4 py-3.5">
            <dt className="sign-label text-ink-2 [--sign-size:11.5px]">{k.label}</dt>
            <dd className="gauge text-[34px] text-ink @3xl:text-[38px]">{k.value}</dd>
            <dd className="text-[15px] leading-snug font-semibold text-ink-2">{k.detail}</dd>
          </div>
        ))}
      </dl>
      {note ? <p className="text-[15px] font-medium text-ink-3">{note}</p> : null}
    </section>
  );
}

export interface FilterChip {
  key: string;
  href: string;
  label: string;
  current: boolean;
}

/** The chosen chip: the register's chosen look (the pale hi-vis wash with an ink edge when quiet). */
const CHOSEN: CSSProperties = {
  backgroundColor: 'var(--chosen-fill)',
  color: 'var(--on-chosen)',
  borderStyle: 'solid',
  borderWidth: 'var(--bw-go)',
  borderColor: 'var(--chosen-edge)',
};

/**
 * Single-choice filter chips as links. The current one carries the chosen look, a tick and
 * aria-current, so it never depends on colour alone. They wrap; they never scroll sideways.
 */
export function FilterChips({ label, items, className }: { label: string; items: readonly FilterChip[]; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cx('flex flex-wrap items-center gap-2', className)}>
      <span aria-hidden className="sign-label w-full text-ink-2 [--sign-size:11.5px]">
        {label}
      </span>
      {items.map((c) => (
        <Link
          key={c.key}
          href={c.href}
          prefetch={false}
          aria-current={c.current ? 'true' : undefined}
          style={c.current ? CHOSEN : undefined}
          className={cx(
            'inline-flex min-h-12 items-center gap-1.5 rounded-control px-4 text-[16px] leading-tight font-bold no-underline transition-colors duration-[var(--t-quick)]',
            !c.current && 'border-[length:var(--bw)] border-solid border-line-strong bg-surface text-ink hover:bg-sunken',
          )}
        >
          {c.current ? <Icon icon={Check} size="xs" /> : null}
          {c.label}
        </Link>
      ))}
    </div>
  );
}

/** A hairline table: sign-label heads over a rule, 1px dividers, numbers right-aligned in Gauge M. */
export const TABLE = {
  /** The plate around a table. No overflow clipping, so row menus can open over the next rows. */
  plate: 'plate',
  table: 'w-full border-collapse text-left text-[16px]',
  headRow: 'border-b-[length:var(--bw-x)] border-solid border-rule',
  th: 'sign-label px-4 pt-3.5 pb-2.5 align-bottom font-bold whitespace-nowrap text-ink-2 [--sign-size:11.5px]',
  thNum: 'text-right',
  body: 'divide-y divide-solid divide-line',
  /** A row whose name link covers the whole row (the link carries ROW_LINK). */
  row: 'relative align-top hover:bg-sunken',
  td: 'px-4 py-3.5',
  tdNum: 'text-right whitespace-nowrap',
} as const;

/** The row's main link: covers its row (a `relative` parent), so the whole row opens it. */
export const ROW_LINK =
  "font-extrabold text-ink no-underline after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:outline-offset-2";

/**
 * Things inside a covered row that keep their own click (menus, PDF links). While a menu inside
 * is open (or focused) it rises above the next rows' actions, which would otherwise cover it.
 */
export const ABOVE_ROW_LINK = 'relative z-10 focus-within:z-20 has-[[aria-expanded=true]]:z-20';

export interface Fact {
  key: string;
  /** Sign label: "Signed option". */
  label: string;
  value: ReactNode;
}

/** Key facts about one record (a job's signed option, quote, estimator, work), divided by hairlines. */
export function FactStrip({ title, facts, className }: { title: string; facts: readonly Fact[]; className?: string }) {
  return (
    <section aria-label={title} className={className}>
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-plate border-solid border-[length:var(--bw)] border-edge bg-line @xl:grid-cols-2 @4xl:grid-cols-4">
        {facts.map((f) => (
          <div key={f.key} className="flex min-w-0 flex-col gap-1.5 bg-surface px-4 py-3.5">
            <dt className="sign-label text-ink-2 [--sign-size:11.5px]">{f.label}</dt>
            <dd className="text-[16px] leading-snug font-semibold text-ink">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

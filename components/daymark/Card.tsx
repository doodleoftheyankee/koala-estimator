// Plates: the basic container. Surface, an edge (2px ink in the field, 1px in the quiet
// register), 16px radius, flat (no soft shadow). Lists are ONE plate with 1px dividers.
//
//   <Card>…</Card>                         padded plate (<section>)
//   <Card as="div" padded={false}>…</Card>
//   <PlateList>{rows.map(r => <li key=…>…</li>)}</PlateList>
//   <Kpi label="Close rate" value={pct(r, 0)} delta="+6 pts vs Oct" deltaTone="ok" />
import type { ElementType, ReactNode } from 'react';
import { cx } from './cx';
import { SignLabel } from './Gauge';

export function Card({
  children,
  className,
  as: Tag = 'section',
  padded = true,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  padded?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  return (
    <Tag id={id} aria-label={ariaLabel} aria-labelledby={labelledBy} className={cx('plate', padded && 'p-4', className)}>
      {children}
    </Tag>
  );
}

/** One plate holding a list, rows divided by 1px lines. Children are <li>. */
export function PlateList({ children, className, 'aria-label': ariaLabel }: { children: ReactNode; className?: string; 'aria-label'?: string }) {
  return (
    <ul aria-label={ariaLabel} className={cx('plate divide-y divide-line overflow-hidden', className)}>
      {children}
    </ul>
  );
}

/** A KPI tile: label, gauge, and a change written in words (never colour alone). */
export function Kpi({
  label,
  value,
  delta,
  deltaTone = 'neutral',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: 'ok' | 'bad' | 'neutral';
  className?: string;
}) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-2', className)}>
      <SignLabel>{label}</SignLabel>
      <span className="gauge text-[40px] text-ink">{value}</span>
      {delta ? <span className={cx('text-[15px] font-bold', deltaTone === 'ok' ? 'text-ok' : deltaTone === 'bad' ? 'text-bad' : 'text-ink-2')}>{delta}</span> : null}
    </div>
  );
}

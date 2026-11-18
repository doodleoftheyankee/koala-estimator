// Numbers are gauges: tall, condensed, tabular numerals with a wide sign label for the meaning and
// the unit. Every quantity a decision depends on (sq ft, price, pitch, count) is shown this way.
// Pass values already formatted by lib/format.ts (money, num, sqft ...); never type a number in.
//
//   <GaugeNumber label="Attic floor" value={num(area)} unit="square feet" size="xl" />
//   <GaugeNumber label="Better" value={money(total)} size="l" />
//   <SignLabel>Price holds until</SignLabel>
//   <SectionHead count={3}>Today</SectionHead>
import type { CSSProperties, ElementType, ReactNode } from 'react';
import { cx } from './cx';

export type GaugeSize = 'xl' | 'l' | 'm';

const GAUGE_SIZE: Record<GaugeSize, string> = {
  xl: 'gauge text-[56px] sm:text-[60px]',
  l: 'gauge text-[36px]',
  m: 'gauge-m text-[22px]',
};

/** A wide caps label (Archivo 118%). size: 11–12.5px, default 12.5. */
export function SignLabel({
  children,
  as: Tag = 'span',
  size,
  tone = 'ink-2',
  className,
  id,
}: {
  children: ReactNode;
  as?: ElementType;
  size?: number;
  tone?: 'ink' | 'ink-2' | 'ink-3' | 'inherit';
  className?: string;
  id?: string;
}) {
  const color = tone === 'inherit' ? undefined : { ink: 'text-ink', 'ink-2': 'text-ink-2', 'ink-3': 'text-ink-3' }[tone];
  const style = size ? ({ '--sign-size': `${size}px` } as CSSProperties) : undefined;
  return (
    <Tag id={id} className={cx('sign-label block', color, className)} style={style}>
      {children}
    </Tag>
  );
}

/** A gauge reading: optional sign label above, the number, an optional unit label below. */
export function GaugeNumber({
  value,
  label,
  unit,
  meaning,
  size = 'l',
  align = 'start',
  className,
}: {
  /** The formatted number ("1,970", "$4,780", "6/12"). */
  value: ReactNode;
  /** What it is ("Attic floor"). */
  label?: ReactNode;
  /** The unit, in a sign label under the number ("square feet"). */
  unit?: ReactNode;
  /** A short meaning line ("Blown-in, on the ceiling"). */
  meaning?: ReactNode;
  size?: GaugeSize;
  align?: 'start' | 'end';
  className?: string;
}) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', align === 'end' && 'items-end text-right', className)}>
      {label ? <SignLabel>{label}</SignLabel> : null}
      {meaning ? <span className="text-[15px] font-semibold leading-snug text-ink-2">{meaning}</span> : null}
      <span className={cx(GAUGE_SIZE[size], 'text-ink')}>{value}</span>
      {unit ? <SignLabel tone="ink">{unit}</SignLabel> : null}
    </div>
  );
}

/** A section head: a sign label, a rule that fills the row, and an optional count. */
export function SectionHead({ children, count, as: Tag = 'h2', className, id }: { children: ReactNode; count?: ReactNode; as?: ElementType; className?: string; id?: string }) {
  return (
    <div className={cx('flex items-center gap-3', className)}>
      <Tag id={id} className="sign-label shrink-0 text-ink">
        {children}
      </Tag>
      <span aria-hidden className="h-[var(--bw-x)] flex-1 rounded-sm bg-rule" />
      {count !== undefined && count !== null ? <span className="gauge-m text-[18px] text-ink">{count}</span> : null}
    </div>
  );
}

/** The screen title (Display): Atkinson 800, 30px. */
export function DisplayTitle({ children, as: Tag = 'h1', className }: { children: ReactNode; as?: ElementType; className?: string }) {
  return <Tag className={cx('text-[30px] font-extrabold leading-[1.07] tracking-[-0.02em] text-ink', className)}>{children}</Tag>;
}

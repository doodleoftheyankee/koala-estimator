'use client';
// Single-choice controls. Hi-vis = what you are choosing; ink = where you are.
//
//   <Segmented label="Overhang" value={o} onChange={setO} options={[{ value: '0', label: 'None' }, …]} />
//   <ChipGroup label="Access" value={a} onChange={setA} options={[{ value: 'easy', label: 'Easy' }, …]} />
//   <StatusBoard label="Show" value={f} onChange={setF} cells={[{ value: 'all', count: num(n), label: 'All' }, …]} />
//   <ReadoutTiles label="Use which area" value={k} onChange={setK} options={[{ value: 'floor', label: 'Attic floor',
//       meaning: 'Blown-in, on the ceiling', gauge: num(floor), unit: 'square feet' }, …]} />
//   <Tabs label="Measure with" value={t} onChange={setT} items={[{ value: 'aerial', label: 'Aerial', icon: Satellite }, …]} />
//
// The chosen value is hi-vis with an ink edge and a keel in the field register, and the pale
// hi-vis wash with an ink edge in the quiet register (tokens --chosen-fill, --on-chosen,
// --chosen-edge). The edge is set inline, so a className cannot remove it. Arrow keys move the
// choice (radio semantics); tabs use ink, never hi-vis.
import type { ReactNode } from 'react';
import { Chip } from './Chip';
import { CHOSEN_STYLE, onRovingKeys, RadioDot } from './chosen';
import { cx } from './cx';
import { Icon, type LucideIcon } from './icons';

// The small shared parts live in ./chosen, so a page that needs only them (the customer quote's
// sign form) does not load every choice control.
export { CHOSEN_STYLE, onRovingKeys, RadioDot };

/** tabIndex for roving focus: the chosen item, or the first when none is chosen. */
const rovingIndex = (on: boolean, i: number, anyOn: boolean) => (on || (!anyOn && i === 0) ? 0 : -1);

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Accessible name when the label is not plain text. */
  ariaLabel?: string;
}

/** Segmented control: 56px cells divided by the edge; the chosen cell is hi-vis. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (v: T) => void;
  className?: string;
}) {
  const anyOn = options.some((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => onRovingKeys(e)}
      className={cx('flex overflow-hidden rounded-control border-solid border-[length:var(--bw)] border-edge bg-surface', className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={rovingIndex(on, i, anyOn)}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            style={on ? CHOSEN_STYLE : undefined}
            className={cx(
              'flex min-h-[var(--ctl-h)] min-w-0 flex-1 items-center justify-center gap-2 px-2 text-[17px] leading-tight font-extrabold transition-colors duration-[var(--t-quick)] focus-visible:-outline-offset-[6px] disabled:text-ink-3',
              i > 0 && 'border-l-[length:var(--bw)] border-solid border-edge',
              !on && 'text-ink hover:bg-sunken',
            )}
          >
            {o.icon ? <Icon icon={o.icon} size="s" /> : null}
            <span className="min-w-0">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Tabs: navigation between panels. The current tab is ink (where you are), never hi-vis. */
export function Tabs<T extends string>({
  label,
  value,
  items,
  onChange,
  className,
}: {
  label: string;
  value: T;
  items: ReadonlyArray<ChoiceOption<T> & { panelId?: string }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => onRovingKeys(e, 'tab')}
      className={cx('flex overflow-hidden rounded-control border-solid border-[length:var(--bw)] border-edge bg-surface', className)}
    >
      {items.map((t, i) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={t.panelId}
            aria-label={t.ariaLabel}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            className={cx(
              'flex min-h-[52px] min-w-0 flex-1 items-center justify-center gap-2 px-2 text-[17px] leading-tight font-extrabold transition-colors duration-[var(--t-quick)] focus-visible:-outline-offset-[6px]',
              i > 0 && 'border-l-[length:var(--bw)] border-solid border-edge',
              on ? 'bg-ink text-on-ink focus-visible:outline-[var(--ink-accent)]' : 'text-ink hover:bg-sunken',
            )}
          >
            {t.icon ? <Icon icon={t.icon} size="s" /> : null}
            <span className="min-w-0">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Single-choice chips that wrap (8px apart for gloves). */
export function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (v: T) => void;
  className?: string;
}) {
  const anyOn = options.some((o) => o.value === value);
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={(e) => onRovingKeys(e)} className={cx('flex flex-wrap gap-2', className)}>
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <Chip
            key={o.value}
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={rovingIndex(on, i, anyOn)}
            selected={on}
            icon={o.icon}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Chip>
        );
      })}
    </div>
  );
}

/** Each board column's share of the width, from its label's length, so DRAFTS and SIGNED fit a phone. */
export const boardColumns = (labels: readonly string[]) => labels.map((l) => `minmax(0, ${Math.max(l.length, 3) + 4}fr)`).join(' ');

/** Status board: a plate of counts that filters the list and doubles as the day's readout. */
export function StatusBoard<T extends string>({
  label,
  value,
  cells,
  onChange,
  className,
}: {
  label: string;
  value: T;
  cells: ReadonlyArray<{ value: T; count: ReactNode; label: string }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => onRovingKeys(e)}
      className={cx('grid overflow-hidden rounded-plate border-solid border-[length:var(--bw)] border-edge bg-surface', className)}
      style={{ gridTemplateColumns: boardColumns(cells.map((c) => c.label)) }}
    >
      {cells.map((c, i) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(c.value)}
            style={on ? CHOSEN_STYLE : undefined}
            className={cx(
              'flex min-h-[76px] min-w-0 flex-col items-start justify-between gap-2 px-2.5 py-2.5 text-left transition-colors duration-[var(--t-quick)] focus-visible:-outline-offset-[6px]',
              i > 0 && 'border-l-[length:var(--bw)] border-solid border-edge',
              !on && 'text-ink hover:bg-sunken',
            )}
          >
            <span className="gauge text-[34px]">{c.count}</span>
            <span className="sign-label max-w-full truncate [--sign-size:11.5px]">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface ReadoutOption<T extends string> {
  value: T;
  /** Sign label: "Attic floor". */
  label: string;
  /** One-line meaning: "Blown-in, on the ceiling". */
  meaning?: ReactNode;
  /** The formatted gauge value: "1,970". */
  gauge: ReactNode;
  /** Unit sign label: "square feet". */
  unit?: ReactNode;
  disabled?: boolean;
}

/**
 * Readout tiles: a radio group of big numbers. The chosen tile is hi-vis on a keel.
 * size: xl (56px gauges, two tiles across) or l (36px, for three narrow tiles such as quote options).
 * compact: 14px padding and 11px sign labels, so "ATTIC FLOOR" stays beside its radio at 390px.
 */
export function ReadoutTiles<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'xl',
  compact = false,
  className,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<ReadoutOption<T>>;
  onChange: (v: T) => void;
  size?: 'xl' | 'l';
  compact?: boolean;
  className?: string;
}) {
  const anyOn = options.some((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => onRovingKeys(e)}
      className={cx('grid grid-cols-2 gap-3', compact && '[--sign-size:11px]', className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={rovingIndex(on, i, anyOn)}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            style={on ? { ...CHOSEN_STYLE, boxShadow: `${CHOSEN_STYLE.boxShadow}, var(--keel-go)` } : undefined}
            className={cx(
              'flex min-w-0 flex-col items-start gap-2 rounded-plate text-left press transition-colors duration-[var(--t-quick)] disabled:opacity-60',
              compact ? 'p-3.5' : 'p-4',
              !on && 'border-solid border-[length:var(--bw)] border-edge bg-surface text-ink hover:bg-sunken',
            )}
          >
            <span className="flex items-center gap-2.5">
              <RadioDot on={on} />
              <span className="sign-label">{o.label}</span>
            </span>
            {o.meaning ? <span className="text-[15px] leading-snug font-semibold opacity-90">{o.meaning}</span> : null}
            <span className={cx('gauge mt-1 max-w-full', size === 'xl' ? 'text-[56px]' : 'text-[36px]')}>{o.gauge}</span>
            {o.unit ? <span className="sign-label">{o.unit}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

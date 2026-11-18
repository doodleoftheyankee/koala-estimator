// A chip: a 48px choice or filter. Selected = the chosen look (hi-vis with an ink edge in the field,
// the wash with an ink edge in the quiet register), enforced inline.
//
//   <Chip selected={on} onClick={toggle}>Air seal</Chip>          a toggle (aria-pressed)
//   use ChipGroup (choice.tsx) for single choice (radio semantics)
import type { ComponentProps } from 'react';
import { cx } from './cx';
import { Icon, type LucideIcon } from './icons';

export type ChipProps = ComponentProps<'button'> & { selected?: boolean; icon?: LucideIcon };

export function Chip({ selected = false, icon, className, style, children, type = 'button', role, ...props }: ChipProps) {
  return (
    <button
      type={type}
      role={role}
      aria-pressed={role ? undefined : selected}
      className={cx(
        'inline-flex min-h-12 items-center gap-2 rounded-control border-solid px-4 text-base leading-tight font-bold transition-colors duration-[var(--t-quick)] disabled:cursor-not-allowed disabled:text-ink-3',
        selected ? 'text-on-chosen' : 'border-[length:var(--bw)] border-line-strong bg-surface text-ink hover:bg-sunken',
        className,
      )}
      style={
        selected
          ? { ...style, backgroundColor: 'var(--chosen-fill)', color: 'var(--on-chosen)', borderStyle: 'solid', borderWidth: 'var(--bw-go)', borderColor: 'var(--chosen-edge)' }
          : style
      }
      {...props}
    >
      {icon ? <Icon icon={icon} size="s" /> : null}
      {children}
    </button>
  );
}

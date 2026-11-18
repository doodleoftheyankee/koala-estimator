// Form controls: 56px (48 in the quiet register), an edge in --line-strong, 18px text so iOS
// never zooms, a thick ink focus ring. Errors sit under the field in red with an icon, after the
// person has touched it; the reason is in words, never colour alone.
//
//   <Field label="Customer name" error={err}><Input value={v} onChange={…} /></Field>
//   <Field label="Access" group><ChipGroup …/></Field>          a group of buttons (no <label>)
//   <SwitchRow checked={on} onChange={setOn} label="Show roof edges" hint="On the photo" />
//   <Switch checked={on} onChange={setOn} label="Face 2" />   just the 76×36 switch
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from './cx';
import { Icon, OctagonAlert } from './icons';

export function Field({
  label,
  hint,
  error,
  children,
  className,
  group = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode | null;
  children: ReactNode;
  className?: string;
  /** Use for button groups (chips): a <label> around several buttons would mislabel them. */
  group?: boolean;
}) {
  const id = useId();
  const below = error ? (
    <span className="mt-1.5 flex items-start gap-1.5 text-[15px] font-bold text-bad">
      <Icon icon={OctagonAlert} size="s" className="mt-px" />
      <span>{error}</span>
    </span>
  ) : hint ? (
    <span className="mt-1.5 block text-[15px] leading-snug font-medium text-ink-2">{hint}</span>
  ) : null;
  const head = 'mb-1.5 block text-[16px] leading-snug font-bold text-ink';
  if (group) {
    return (
      <div role="group" aria-labelledby={id} className={cx('block', className)}>
        <span id={id} className={head}>
          {label}
        </span>
        {children}
        {below}
      </div>
    );
  }
  return (
    <label className={cx('block', className)}>
      <span className={head}>{label}</span>
      {children}
      {below}
    </label>
  );
}

/** Shared look for text inputs, selects and text areas. */
export const INPUT_CLASS =
  'block w-full min-h-[var(--ctl-h)] rounded-control border-solid border-[length:var(--bw)] border-line-strong bg-surface px-3.5 text-[18px] font-semibold text-ink placeholder:font-medium placeholder:text-ink-3 focus:border-ink focus-visible:outline-offset-2 aria-invalid:border-bad disabled:border-line disabled:bg-draft-fill disabled:text-ink-2 read-only:bg-sunken';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cx(INPUT_CLASS, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cx(INPUT_CLASS, 'py-2.5', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cx(INPUT_CLASS, 'pr-9', className)} {...props} />;
}

/** The 76×36 switch with ON or OFF written inside. On is ink (state, not a choice). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('inline-flex min-h-12 shrink-0 items-center justify-center disabled:opacity-60', className)}
    >
      <SwitchTrack on={checked} />
    </button>
  );
}

/** The switch graphic alone (aria-hidden): use inside a control that carries role="switch". */
export function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'relative inline-block h-9 w-[76px] shrink-0 rounded-full border-solid border-[length:var(--bw)] font-num text-[11.5px] font-extrabold tracking-[0.06em] [font-stretch:110%] transition-colors duration-[var(--t-quick)]',
        on ? 'border-ink bg-ink' : 'border-line-strong bg-surface',
      )}
    >
      <span
        className={cx('absolute h-[26px] w-[26px] rounded-full transition-[left] duration-[var(--t-quick)] ease-daymark', on ? 'bg-on-ink' : 'bg-line-strong')}
        style={{ top: 'calc(50% - 13px)', left: on ? 'calc(100% - 29px)' : '3px' }}
      />
      <span className={cx('absolute top-1/2 -translate-y-1/2 leading-none', on ? 'left-[11px] text-on-ink' : 'right-[9px] text-ink-3')}>{on ? 'ON' : 'OFF'}</span>
    </span>
  );
}

/** A full-width row that is one big switch: label and hint on the left, ON/OFF on the right. */
export function SwitchRow({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'flex min-h-16 w-full items-center justify-between gap-3 rounded-control border-solid border-[length:var(--bw)] border-line-strong bg-surface px-3.5 py-2 text-left transition-colors hover:bg-sunken disabled:opacity-60',
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-[17px] leading-snug font-bold text-ink">{label}</span>
        {hint ? <span className="block text-[15px] leading-snug font-medium text-ink-2">{hint}</span> : null}
      </span>
      <SwitchTrack on={checked} />
    </button>
  );
}

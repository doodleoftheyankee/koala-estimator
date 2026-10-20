// Small, dependency-free UI kit. Big tap targets: estimators use this in attics with gloves on.
import { useId } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-slate-300',
  secondary: 'bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-brand-800 hover:bg-brand-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed',
        size === 'sm' && 'min-h-9 px-3 text-sm',
        size === 'md' && 'min-h-12 px-4 text-base',
        size === 'lg' && 'min-h-14 px-6 text-lg',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  group = false,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  /** Use for button groups (chips): a <label> around several buttons would mislabel them. */
  group?: boolean;
}) {
  const id = useId();
  const below = error ? <span className="mt-1 block text-sm text-red-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null;
  if (group) {
    return (
      <div role="group" aria-labelledby={id} className={cx('block', className)}>
        <span id={id} className="mb-1 block text-sm font-medium text-slate-700">
          {label}
        </span>
        {children}
        {below}
      </div>
    );
  }
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {below}
    </label>
  );
}

const inputBase =
  'block w-full rounded-xl border border-slate-300 bg-white px-3 min-h-12 text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(inputBase, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputBase, 'py-2', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(inputBase, 'pr-8', className)} {...props} />;
}

/** Single-choice chips; easier than a dropdown on a phone. */
export function Chips<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'min-h-11 rounded-full px-4 text-sm font-medium ring-1 transition-colors',
            value === o.value ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl bg-white px-3 text-left ring-1 ring-slate-300"
    >
      <span>
        <span className="block font-medium text-slate-800">{label}</span>
        {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
      </span>
      <span className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-slate-300')}>
        <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0.5')} />
      </span>
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200', className)}>{children}</section>;
}

type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue';
const tones: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  blue: 'bg-sky-100 text-sky-800',
};

export function Badge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', tones[tone])}>{children}</span>;
}

export function Alert({ tone = 'amber', children }: { tone?: 'amber' | 'red' | 'blue' | 'green'; children: ReactNode }) {
  const t = { amber: 'bg-amber-50 text-amber-900 ring-amber-200', red: 'bg-red-50 text-red-900 ring-red-200', blue: 'bg-sky-50 text-sky-900 ring-sky-200', green: 'bg-emerald-50 text-emerald-900 ring-emerald-200' }[tone];
  return <div className={cx('rounded-xl px-3 py-2 text-sm ring-1', t)}>{children}</div>;
}

export { cx };

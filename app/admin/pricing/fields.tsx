// Server-renderable input helpers for the pricing page (no hooks, so they can be passed as
// children into the client ActionForm).
import type { ReactNode } from 'react';
import { Field, Input } from '@/components/ui';

/** A decimal text input with an optional "$" prefix or "%" / unit suffix. */
export function NumberField({
  label,
  name,
  defaultValue,
  hint,
  prefix,
  suffix,
  integer = false,
  required = true,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue: string | number | null | undefined;
  hint?: ReactNode;
  prefix?: string;
  suffix?: string;
  integer?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <span className="relative block">
        {prefix ? <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-500">{prefix}</span> : null}
        <Input
          name={name}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          autoComplete="off"
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue === null || defaultValue === undefined ? '' : String(defaultValue)}
          className={[prefix ? 'pl-7' : '', suffix ? 'pr-14' : ''].join(' ')}
        />
        {suffix ? <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-500">{suffix}</span> : null}
      </span>
    </Field>
  );
}

export function TextField({
  label,
  name,
  defaultValue,
  hint,
  type = 'text',
  required = false,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue: string | null | undefined;
  hint?: ReactNode;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input name={name} type={type} required={required} placeholder={placeholder} defaultValue={defaultValue ?? ''} />
    </Field>
  );
}

/** Section heading with an anchor target that clears the sticky section nav. */
export function SectionHeading({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-20">
      <h2 className="text-xl font-bold text-slate-900">{title}</h2>
      {children ? <div className="mt-1 text-sm text-slate-600">{children}</div> : null}
    </div>
  );
}

'use client';
// A form bound to an admin Server Action, with a pending state and an inline save status.
// Submits through onSubmit + startTransition (not the form `action` prop) so React does not
// reset the inputs when a save is refused: the owner keeps what they typed and can fix it.
import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Toggle } from '@/components/ui';
import type { ActionResult } from '@/lib/admin/forms';

export type AdminAction = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export function ActionForm({
  action,
  readOnly,
  submitLabel = 'Save',
  resetOnSuccess = false,
  className,
  children,
}: {
  action: AdminAction;
  readOnly: boolean;
  submitLabel?: string;
  resetOnSuccess?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  const [dirty, setDirty] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={formRef}
      className={className}
      onInput={() => setDirty(true)}
      onSubmit={(e) => {
        e.preventDefault();
        if (readOnly) return;
        const fd = new FormData(e.currentTarget);
        setDirty(false);
        startTransition(() => dispatch(fd));
      }}
    >
      <fieldset disabled={readOnly || pending} className="min-w-0 space-y-3 [&:disabled_[role=switch]]:cursor-not-allowed [&:disabled_[role=switch]]:opacity-70">
        {children}
      </fieldset>
      {readOnly ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? 'Saving…' : submitLabel}
          </Button>
          <div aria-live="polite" className="min-w-0 flex-1 text-sm">
            {pending ? null : state && !dirty ? (
              state.ok ? (
                <span className="font-medium text-emerald-700">{state.message ?? 'Saved.'}</span>
              ) : (
                <Alert tone="red">{state.error}</Alert>
              )
            ) : dirty ? (
              <span className="text-slate-500">Unsaved changes</span>
            ) : null}
          </div>
        </div>
      )}
    </form>
  );
}

/** The kit's Toggle plus a hidden input so it submits with the form ("true"/"false"). */
export function ToggleInput({ name, label, hint, defaultChecked }: { name: string; label: string; hint?: string; defaultChecked: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  const hiddenRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={hiddenRef} type="hidden" name={name} value={checked ? 'true' : 'false'} />
      <Toggle
        label={label}
        hint={hint}
        checked={checked}
        onChange={(v) => {
          setChecked(v);
          // Hidden inputs do not fire input events; let the form know it is dirty.
          hiddenRef.current?.form?.dispatchEvent(new Event('input', { bubbles: true }));
        }}
      />
    </>
  );
}

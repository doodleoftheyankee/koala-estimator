'use client';
// Owner controls on the learning dashboard. Each one submits a Server Action through
// useActionState (like ../pricing/ActionForm). Decisions that change pricing take a second tap:
// the first shows what will happen and a confirm button, so nothing is sent by a stray touch.
import { startTransition, useActionState, useState, type ReactNode } from 'react';
import { Alert, Button, Field, Textarea } from '@/components/ui';
import type { AdminAction } from '../pricing/ActionForm';

type Variant = 'primary' | 'secondary' | 'danger';

function ConfirmForm({
  action,
  submitLabel,
  pendingLabel,
  submitVariant = 'primary',
  confirm,
  confirmLabel,
  confirmVariant = 'primary',
  onCancel,
  children,
}: {
  action: AdminAction;
  submitLabel: string;
  pendingLabel: string;
  submitVariant?: Variant;
  /** Shown after the first tap; the action runs on the second. Omit to run on the first tap. */
  confirm?: ReactNode;
  confirmLabel?: string;
  confirmVariant?: Variant;
  /** Adds a Cancel button next to the first-tap button (e.g. to collapse an inline form). */
  onCancel?: () => void;
  children?: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  const [armed, setArmed] = useState(false);
  const [dirty, setDirty] = useState(false);

  return (
    <form
      onInput={() => {
        setDirty(true);
        setArmed(false);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        // The first tap goes through the browser's own validation (required reason) before arming.
        if (confirm && !armed) {
          setArmed(true);
          return;
        }
        const fd = new FormData(e.currentTarget);
        setArmed(false);
        setDirty(false);
        startTransition(() => dispatch(fd));
      }}
    >
      {children ? (
        <fieldset disabled={pending} className="min-w-0 space-y-3">
          {children}
        </fieldset>
      ) : null}
      <div className={children ? 'mt-3 space-y-3' : 'space-y-3'}>
        {armed ? (
          <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 ring-1 ring-amber-200">
            <div>{confirm}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {/* Focus moves here so a keyboard or screen-reader user lands on the decision. */}
              <Button type="submit" variant={confirmVariant} autoFocus>
                {confirmLabel ?? submitLabel}
              </Button>
              <Button variant="secondary" onClick={() => setArmed(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant={submitVariant} disabled={pending} aria-busy={pending}>
              {pending ? pendingLabel : submitLabel}
            </Button>
            {onCancel && !pending ? (
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        )}
        <div aria-live="polite" className="text-sm">
          {pending || dirty || !state ? null : state.ok ? (
            <p className="font-medium text-emerald-700">{state.message ?? 'Done.'}</p>
          ) : (
            <Alert tone="red">{state.error}</Alert>
          )}
        </div>
      </div>
    </form>
  );
}

const REASON_MAX = 500;

/** "Run learning now": the nightly job on demand, with its outcome below the button. */
export function RunNowForm({ action }: { action: AdminAction }) {
  return <ConfirmForm action={action} submitLabel="Run learning now" pendingLabel="Running… this can take a minute" />;
}

/** Approve the pending candidate: optional reason, then a confirm step. */
export function ApproveForm({ action, setId, version, changed }: { action: AdminAction; setId: string; version: number; changed: number }) {
  return (
    <ConfirmForm
      action={action}
      submitLabel={`Approve v${version}`}
      pendingLabel="Approving…"
      confirmLabel={`Yes, approve v${version}`}
      confirm={
        <p>
          Pricing switches to v{version} right away{changed ? ` (${changed} ${changed === 1 ? 'coefficient changes' : 'coefficients change'})` : ''}.
          Estimators pick it up the next time their app syncs. You can restore the current set from History at any time.
        </p>
      }
    >
      <input type="hidden" name="set_id" value={setId} />
      <Field label="Reason (optional)" hint="Saved in the changelog next to every coefficient that moves.">
        <Textarea name="reason" rows={2} maxLength={REASON_MAX} placeholder="e.g. Matches what the crews reported this month" />
      </Field>
    </ConfirmForm>
  );
}

/** Reject the pending candidate: a reason is required, then a confirm step. */
export function RejectForm({ action, setId, version }: { action: AdminAction; setId: string; version: number }) {
  return (
    <ConfirmForm
      action={action}
      submitLabel={`Reject v${version}`}
      pendingLabel="Rejecting…"
      submitVariant="secondary"
      confirmLabel={`Yes, reject v${version}`}
      confirmVariant="danger"
      confirm={<p>Pricing keeps using the active set. The next nightly run starts again from the active set.</p>}
    >
      <input type="hidden" name="set_id" value={setId} />
      <Field label="Reason" hint="Required. Saved on the set and in the audit log.">
        <Textarea name="reason" rows={2} required maxLength={REASON_MAX} placeholder="e.g. Two jobs had bad actuals; re-check before approving" />
      </Field>
    </ConfirmForm>
  );
}

/** "Restore this version" on a past set: expands into a reason prompt with a confirm step. */
export function RestoreSetButton({
  action,
  setId,
  version,
  activeVersion,
}: {
  action: AdminAction;
  setId: string;
  version: number;
  activeVersion: number | null;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Restore this version
      </Button>
    );
  }
  return (
    <div className="min-w-64 max-w-sm whitespace-normal">
      <ConfirmForm
        action={action}
        submitLabel={`Restore v${version}`}
        pendingLabel="Restoring…"
        confirmLabel={`Yes, restore v${version}`}
        confirmVariant="danger"
        onCancel={() => setOpen(false)}
        confirm={
          <p>
            Pricing switches to a copy of v{version} right away.
            {activeVersion !== null ? ` v${activeVersion} stays in History and can be restored later.` : ''}
          </p>
        }
      >
        <input type="hidden" name="set_id" value={setId} />
        <Field label="Why restore it?" hint="Required. Saved in the changelog.">
          <Textarea name="reason" rows={2} required maxLength={REASON_MAX} placeholder="e.g. Last night's labor rates look wrong" />
        </Field>
      </ConfirmForm>
    </div>
  );
}

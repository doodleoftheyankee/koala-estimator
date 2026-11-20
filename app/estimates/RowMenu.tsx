'use client';
// The "More" menu on an estimate row (UX-06): Open, the quote PDF, and Mark lost… in quiet red
// text. Mark lost… opens a confirm sheet that says what will happen and asks why; nothing changes
// until "Mark lost" is pressed there. The action and its rules are unchanged (./actions.ts).
import Link from 'next/link';
import { startTransition, useActionState, useEffect, useId, useRef, useState } from 'react';
import { Banner, Button, cx, Download, Ellipsis, Field, FileText, Icon, Sheet, Textarea, useToast, X } from '@/components/daymark';
import type { ActionResult } from '@/lib/admin/forms';
import { markLost } from './actions';

const ITEM =
  'flex min-h-12 w-full items-center gap-3 rounded-control px-3 text-left text-[16px] font-bold no-underline hover:bg-sunken focus-visible:-outline-offset-2';

export function RowMenu({
  id,
  customer,
  address,
  openHref,
  pdfHref,
  openQuoteVersion,
  canMarkLost,
  className,
}: {
  id: string;
  customer: string;
  /** Street and town, so the confirm step names the right house. */
  address: string | null;
  openHref: string;
  /** The latest quote's PDF, when there is one. */
  pdfHref: string | null;
  /** The version of a quote the customer can still sign; marking lost closes it. */
  openQuoteVersion: number | null;
  canMarkLost: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={wrap}
      className={cx('relative', className)}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`More for ${customer}`}
        title="More"
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'inline-flex h-12 w-12 items-center justify-center rounded-control border-[length:var(--bw)] border-solid text-ink',
          open ? 'border-edge bg-sunken' : 'border-transparent hover:border-line-strong hover:bg-sunken',
        )}
      >
        <Icon icon={Ellipsis} />
      </button>
      <div
        id={menuId}
        hidden={!open}
        className="absolute top-full right-0 z-30 mt-1 w-64 rounded-control border-[length:var(--bw)] border-solid border-edge bg-surface p-1.5 text-ink shadow-lift"
      >
        <ul className="space-y-0.5">
          <li>
            <Link data-menu-item href={openHref} prefetch={false} className={ITEM}>
              <Icon icon={FileText} size="s" />
              Open estimate
            </Link>
          </li>
          {pdfHref ? (
            <li>
              <a data-menu-item href={pdfHref} target="_blank" rel="noopener" className={ITEM} onClick={() => setOpen(false)}>
                <Icon icon={Download} size="s" />
                Quote PDF
              </a>
            </li>
          ) : null}
          {canMarkLost ? (
            <li className="mt-1 border-t-[length:var(--bw)] border-solid border-line pt-1">
              <button
                data-menu-item
                type="button"
                className={cx(ITEM, 'text-bad hover:bg-bad-fill')}
                onClick={() => {
                  setOpen(false);
                  setConfirming(true);
                }}
              >
                <Icon icon={X} size="s" />
                Mark lost…
              </button>
            </li>
          ) : null}
        </ul>
      </div>
      {confirming ? (
        <MarkLostSheet
          id={id}
          customer={customer}
          address={address}
          openQuoteVersion={openQuoteVersion}
          onClose={() => {
            setConfirming(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

/** The confirm step: what marking lost does, and why it was lost (required, as before). */
function MarkLostSheet({
  id,
  customer,
  address,
  openQuoteVersion,
  onClose,
}: {
  id: string;
  customer: string;
  address: string | null;
  openQuoteVersion: number | null;
  onClose: () => void;
}) {
  const [state, dispatch, pending] = useActionState(markLost, null);
  const handled = useRef<ActionResult | null>(null);
  const toast = useToast();
  const formId = useId();
  const reason = useRef<HTMLTextAreaElement>(null);

  // The sheet opens (showModal) in its own effect, which runs first; then put the cursor in the box.
  useEffect(() => {
    reason.current?.focus();
  }, []);

  useEffect(() => {
    if (!state?.ok || handled.current === state) return;
    handled.current = state;
    toast.show({ message: `Marked lost: ${customer}` });
    onClose();
  }, [state, toast, customer, onClose]);

  return (
    <Sheet
      open
      onClose={onClose}
      title="Mark this estimate lost?"
      closeLabel="Close without marking lost"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={pending}>
            Keep it
          </Button>
          <Button type="submit" form={formId} variant="danger" disabled={pending} aria-busy={pending}>
            {pending ? 'Saving…' : 'Mark lost'}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          startTransition(() => dispatch(fd));
        }}
      >
        <div className="space-y-2 text-[16px] font-medium text-ink">
          <p>
            <span className="block text-[18px] font-extrabold">{customer}</span>
            {address ? <span className="block text-ink-2">{address}</span> : null}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-ink-2">
            {openQuoteVersion !== null ? <li>The customer can no longer sign quote v{openQuoteVersion}.</li> : null}
            <li>It counts as a lost sale in Insights.</li>
            <li>The app cannot undo this.</li>
          </ul>
        </div>
        <input type="hidden" name="id" value={id} />
        <Field label="Why was it lost?" hint="Price, timing, went with a competitor, no response…">
          <Textarea ref={reason} name="reason" rows={3} required maxLength={500} disabled={pending} />
        </Field>
        {state && !state.ok ? (
          <Banner tone="bad" title="Not marked lost">
            {state.error}
          </Banner>
        ) : null}
      </form>
    </Sheet>
  );
}

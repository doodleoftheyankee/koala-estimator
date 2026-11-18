'use client';
// A bottom sheet over a scrim (a modal <dialog>): X to close, a title, the body, and one named
// primary action in the footer. Escape and the X close it; focus returns to where it was.
// It rises from the dock in 220ms (no motion with reduced motion).
//
//   <Sheet open={open} onClose={() => setOpen(false)} title="Attic size"
//          footer={<Button variant="primary" size="lg" block onClick={use}>Use {sqft(a)}</Button>}>
//     …
//   </Sheet>
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';
import { cx } from './cx';
import { X } from './icons';

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  closeLabel = 'Close',
  register,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeLabel?: string;
  /** The register of the page it opens over ('quiet' on office screens). A <dialog> sits in the
   * top layer, so it says its register itself. */
  register?: 'quiet';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-register={register}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // a tap on the scrim
      }}
      className={cx(
        'm-0 mt-auto mx-auto max-h-[92dvh] w-full max-w-2xl overflow-hidden rounded-t-sheet border-x-[length:var(--bw)] border-t-[length:var(--bw-x)] border-b-0 border-solid border-edge bg-surface p-0 text-ink shadow-lift backdrop:bg-scrim open:flex open:flex-col open:animate-[dm-rise_var(--t-move)_var(--ease)]',
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-solid border-line px-4 py-2.5">
        <h2 id={titleId} className="min-w-0 flex-1 text-[22px] leading-tight font-extrabold">
          {title}
        </h2>
        <IconButton icon={X} label={closeLabel} variant="ghost" onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
      {footer ? <footer className="shrink-0 border-t-[length:var(--bw-x)] border-solid border-rule px-4 pt-3 pb-[max(12px,var(--safe-bottom))]">{footer}</footer> : null}
    </dialog>
  );
}

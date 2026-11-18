'use client';
// Success toast: ink, a hi-vis tick and a plain sentence ("Sent to Jordan Blake"). Shows for 4 s
// and offers Undo where that is safe. One at a time; a new toast replaces the old one.
// <ToastProvider> is mounted once in app/layout.tsx; call useToast() anywhere below it.
//
//   const toast = useToast();
//   toast.show({ message: 'Area deleted', undo: () => restore(area) });
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './cx';
import { CircleCheck, Icon, OctagonAlert } from './icons';

export interface ToastInput {
  message: ReactNode;
  /** Offer Undo. Called once if the person taps it; the toast then closes. */
  undo?: () => void;
  /** ok (default) for success, bad for a failure that needs no action. */
  tone?: 'ok' | 'bad';
  /** Milliseconds on screen (default 4000; 8000 when there is an Undo). */
  duration?: number;
}

interface ToastApi {
  show: (t: ToastInput) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Toasts for this subtree. Without a provider, show() does nothing (no crash). */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
const NOOP: ToastApi = { show: () => undefined, dismiss: () => undefined };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(null);
  const seq = useRef(0);
  const dismiss = useCallback(() => setToast(null), []);
  const show = useCallback((t: ToastInput) => setToast({ ...t, id: ++seq.current }), []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  useEffect(() => {
    if (!toast) return;
    const ms = toast.duration ?? (toast.undo ? 8000 : 4000);
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), ms);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-[calc(108px+var(--safe-bottom))] z-50 flex justify-center px-4">
        {toast ? <ToastView key={toast.id} toast={toast} onClose={dismiss} /> : null}
      </div>
    </ToastContext.Provider>
  );
}

/** The toast itself; exported for the /design page. */
export function ToastView({ toast, onClose, className }: { toast: ToastInput; onClose?: () => void; className?: string }) {
  const bad = toast.tone === 'bad';
  return (
    <div
      className={cx(
        'pointer-events-auto flex min-h-14 w-full max-w-md items-center gap-3 rounded-control bg-ink py-2 pr-2 pl-4 text-[16.5px] font-bold text-on-ink shadow-lift animate-[dm-rise_var(--t-move)_var(--ease)]',
        className,
      )}
    >
      <span className={bad ? 'text-bad-fill' : 'text-ink-accent'}>
        <Icon icon={bad ? OctagonAlert : CircleCheck} />
      </span>
      <span className="min-w-0 flex-1">{toast.message}</span>
      {toast.undo ? (
        <button
          type="button"
          onClick={() => {
            toast.undo?.();
            onClose?.();
          }}
          className="min-h-12 shrink-0 rounded-control px-4 font-extrabold text-ink-accent underline underline-offset-4 focus-visible:outline-[var(--ink-accent)]"
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}

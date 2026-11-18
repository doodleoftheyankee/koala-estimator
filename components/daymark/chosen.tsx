'use client';
// The chosen look and roving arrow keys shared by every single-choice control (./choice.tsx) and
// by the customer quote's option picker. Kept apart from the controls themselves so the public
// quote page loads only these few lines.
import type { CSSProperties, KeyboardEvent } from 'react';
import { cx } from './cx';

/** The chosen look, enforced inline: fill, text and an edge at least 2px. */
export const CHOSEN_STYLE: CSSProperties = {
  backgroundColor: 'var(--chosen-fill)',
  color: 'var(--on-chosen)',
  boxShadow: 'inset 0 0 0 var(--bw-go) var(--chosen-edge)',
};

const KEYS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Roving arrow-key handler for a radiogroup or tablist: moves focus and selects. */
export function onRovingKeys(e: KeyboardEvent<HTMLElement>, role: 'radio' | 'tab' = 'radio') {
  const step = KEYS[e.key];
  if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(`[role="${role}"]:not([disabled])`));
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0 || items.length === 0) return;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (step ?? 0) + items.length) % items.length;
  e.preventDefault();
  const el = items[next];
  el?.focus();
  el?.click();
}

/** The radio circle used in tiles: a ring, with a dot when chosen. */
export function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-solid border-[length:var(--bw-go)]',
        on ? 'border-current' : 'border-line-strong',
      )}
    >
      {on ? <span className="h-2.5 w-2.5 rounded-full bg-current" /> : null}
    </span>
  );
}

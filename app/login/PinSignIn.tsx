'use client';
// Sign in with your name and a 4-digit PIN (staff with no work email). Tap your name, then type
// the PIN on big keys; the fourth digit sends it (POST /auth/pin) and the page opens the person's
// home. A wrong PIN says how many tries are left; 5 wrong in a row lock the name for 15 minutes.
// A computer keyboard works too: digits, Backspace, and Escape to go back to the names.
import { useEffect, useRef, useState } from 'react';
import { PIN_LENGTH } from '@/lib/auth/pinShared';
import { safeNext } from '@/lib/safeNext';
import { Banner } from '@/components/daymark/Banner';
import { buttonClass } from '@/components/daymark/Button';
import { cx } from '@/components/daymark/cx';
import { ChevronLeft, ChevronRight, Delete, Icon } from '@/components/daymark/icons';

/** A person listed on the sign-in page: their id and "First · Role", nothing more. */
export interface PinPerson {
  id: string;
  label: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const UNREACHABLE = "Can't reach Koala right now. Try again in a minute.";
const NO_SIGNAL = 'No connection. Check your signal and try again.';

export function PinSignIn({ people, next }: { people: PinPerson[]; next: string }) {
  const [who, setWho] = useState<PinPerson | null>(null);
  const [digits, setDigitsState] = useState('');
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Taps can come faster than the screen updates: the refs hold what has been typed so far.
  const typed = useRef('');
  const sending = useRef(false);
  const padHeading = useRef<HTMLHeadingElement>(null);
  const namesHeading = useRef<HTMLHeadingElement>(null);
  const setDigits = (v: string) => {
    typed.current = v;
    setDigitsState(v);
  };
  const setBusy = (v: boolean) => {
    sending.current = v;
    setBusyState(v);
  };

  function choose(person: PinPerson | null) {
    setWho(person);
    setDigits('');
    setError(null);
  }

  async function send(person: PinPerson, pin: string) {
    setBusy(true);
    let message: string;
    try {
      const res = await fetch('/auth/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: person.id, pin, next }),
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; to?: unknown; message?: unknown } | null;
      if (body?.ok === true && typeof body.to === 'string') {
        // Signed in: a full page load, so the app (and its offline copy) starts as this person.
        window.location.replace(safeNext(body.to));
        return;
      }
      message = typeof body?.message === 'string' ? body.message : UNREACHABLE;
    } catch {
      message = navigator.onLine ? UNREACHABLE : NO_SIGNAL;
    }
    setBusy(false);
    setDigits('');
    setError(message);
  }

  function press(d: string) {
    if (!who || sending.current || typed.current.length >= PIN_LENGTH) return;
    const v = typed.current + d;
    setDigits(v);
    setError(null);
    if (v.length === PIN_LENGTH) void send(who, v);
  }

  function rubOut() {
    if (sending.current) return;
    setDigits(typed.current.slice(0, -1));
  }

  // Move focus with the screen, for keyboards and screen readers (not when the page opens).
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    (who ? padHeading : namesHeading).current?.focus({ preventScroll: true });
  }, [who]);

  useEffect(() => {
    if (!who) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // typing in the email form below
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        rubOut();
      } else if (e.key === 'Escape' && !sending.current) {
        choose(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!who) {
    return (
      <section aria-labelledby="pin-names" className="space-y-3">
        <h2 id="pin-names" ref={namesHeading} tabIndex={-1} className="sign-label text-ink-2 outline-none">
          Tap your name
        </h2>
        <ul className="overflow-hidden rounded-plate border-[length:var(--bw)] border-solid border-edge bg-surface">
          {people.map((p, i) => (
            <li key={p.id} className={i > 0 ? 'border-t border-solid border-line' : undefined}>
              <button type="button" onClick={() => choose(p)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken">
                <span className="min-w-0 flex-1 text-[19px] leading-tight font-extrabold text-ink">{p.label}</span>
                <Icon icon={ChevronRight} size="s" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const key = buttonClass({ variant: 'secondary', size: 'lg', block: true, disabled: busy }, 'min-h-[72px] text-[30px]');
  return (
    <section aria-labelledby="pin-pad" className="plate space-y-4 p-4 sm:p-5">
      <button type="button" onClick={() => choose(null)} disabled={busy} className="-ml-1 inline-flex min-h-12 items-center gap-1 px-1 text-[16px] font-bold text-ink underline underline-offset-4 disabled:opacity-60">
        <Icon icon={ChevronLeft} size="s" />
        Back
      </button>
      <div>
        <h2 id="pin-pad" ref={padHeading} tabIndex={-1} className="text-[24px] leading-tight font-extrabold text-ink outline-none">
          {who.label}
        </h2>
        <p className="mt-1 text-[16px] font-medium text-ink-2">Enter your {PIN_LENGTH}-digit PIN.</p>
      </div>
      <div className="flex justify-center gap-5 py-1" aria-hidden>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={cx('size-5 rounded-full border-[length:var(--bw)] border-solid border-ink', i < digits.length ? 'bg-ink' : 'bg-surface')} />
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {busy ? 'Checking your PIN' : `${digits.length} of ${PIN_LENGTH} digits entered`}
      </p>
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <div role="group" aria-label="PIN pad" className="grid grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button key={k} type="button" className={key} disabled={busy} onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <span aria-hidden />
        <button type="button" className={key} disabled={busy} onClick={() => press('0')}>
          0
        </button>
        <button type="button" className={key} disabled={busy || digits.length === 0} onClick={rubOut} aria-label="Delete the last digit">
          <Icon icon={Delete} size="l" />
        </button>
      </div>
      {busy ? <p className="text-center text-[16px] font-bold text-ink-2">Checking…</p> : null}
    </section>
  );
}

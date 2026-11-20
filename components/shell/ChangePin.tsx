'use client';
// "Change my PIN", in the account menu of someone who signs in with their name and PIN: the
// current PIN, then the new one twice. The server checks the current PIN as signing in does (a
// wrong one counts toward the same lockout) and keeps this phone signed in (POST /api/account/pin).
// It needs a signal; the rest of the menu works without one.
import { useState, type FormEvent } from 'react';
import { newPinProblem, PIN_LENGTH } from '@/lib/auth/pinShared';
import { Banner } from '../daymark/Banner';
import { Button } from '../daymark/Button';
import { Field, Input } from '../daymark/Form';
import { KeyRound } from '../daymark/icons';

const UNREACHABLE = "Can't reach Koala right now. Your PIN was not changed.";
const NO_SIGNAL = 'No connection. Changing your PIN needs a signal.';

function PinBox({ name, label }: { name: string; label: string }) {
  return (
    <Field label={label}>
      <Input name={name} type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_LENGTH} autoComplete="off" required className="tracking-[0.3em]" />
    </Field>
  );
}

export function ChangePin({ online }: { online: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = { current: fd.get('current'), pin: fd.get('pin'), again: fd.get('again') };
    const problem = newPinProblem(body.current, body.pin, body.again);
    if (problem) {
      setSaid({ ok: false, message: problem });
      return;
    }
    setBusy(true);
    setSaid(null);
    let out: { ok: boolean; message: string };
    try {
      const res = await fetch('/api/account/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as { ok?: unknown; message?: unknown } | null;
      out = typeof json?.message === 'string' ? { ok: json.ok === true, message: json.message } : { ok: false, message: UNREACHABLE };
    } catch {
      out = { ok: false, message: navigator.onLine ? UNREACHABLE : NO_SIGNAL };
    }
    setBusy(false);
    setSaid(out);
    if (out.ok) setOpen(false);
  }

  return (
    <section aria-label="Your PIN" className="space-y-3">
      {open ? (
        <form onSubmit={onSubmit} className="plate space-y-4 p-4" aria-labelledby="change-pin">
          <h3 id="change-pin" className="text-[18px] font-extrabold">
            Change my PIN
          </h3>
          <PinBox name="current" label="Current PIN" />
          <PinBox name="pin" label={`New PIN (${PIN_LENGTH} digits)`} />
          <PinBox name="again" label="New PIN again" />
          {said && !said.ok ? <Banner tone="bad">{said.message}</Banner> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="main" disabled={busy || !online}>
              {busy ? 'Saving…' : 'Save new PIN'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setSaid(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {!online ? <p className="text-[15px] font-semibold text-ink-2">Changing your PIN needs a signal.</p> : null}
        </form>
      ) : (
        <Button
          icon={KeyRound}
          block
          disabled={!online}
          onClick={() => {
            setOpen(true);
            setSaid(null);
          }}
        >
          Change my PIN
        </Button>
      )}
      {said?.ok ? <Banner tone="ok">{said.message}</Banner> : null}
    </section>
  );
}

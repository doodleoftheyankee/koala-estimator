'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/browser';
import { sendCodeErrorMessage, verifyErrorMessage } from '@/lib/auth/loginMessages';
import { Banner, Button, Field, Input } from '@/components/daymark';
import { Mail, RefreshCw } from '@/components/daymark/icons';

// Email one-time code. The 6-digit code works inside the installed PWA, where a magic link
// would open a separate browser tab. The email also contains a link for desktop use.
export function LoginForm({ next, initialError }: { next: string; initialError: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [resent, setResent] = useState(false);

  async function requestCode(): Promise<boolean> {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    let failure: string | null = null;
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}` },
      });
      if (error) failure = error.message;
    } catch (e) {
      failure = e instanceof Error ? e.message : 'network';
    }
    setBusy(false);
    if (failure !== null) setError(sendCodeErrorMessage(failure, navigator.onLine));
    return failure === null;
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    if (await requestCode()) {
      setResent(false);
      setStage('code');
    }
  }

  async function resend() {
    setCode('');
    if (await requestCode()) setResent(true);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    let failure: string | null = null;
    try {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
      if (error) failure = error.message;
    } catch (e) {
      failure = e instanceof Error ? e.message : 'network';
    }
    setBusy(false);
    if (failure !== null) setError(verifyErrorMessage(failure, navigator.onLine));
    else {
      router.replace(next);
      router.refresh();
    }
  }

  return (
    <div className="space-y-5">
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {stage === 'email' ? (
        <form onSubmit={sendCode} className="space-y-5">
          <Field label="Work email" hint="We email you a 6-digit code. No password needed.">
            <Input type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" icon={Mail} block disabled={busy || !email}>
            {busy ? 'Sending…' : 'Email me a sign-in code'}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-5">
          <p className="text-[16px] font-medium text-ink-2" aria-live="polite">
            {resent ? 'We sent a new 6-digit code to ' : 'We sent a 6-digit code to '}
            <strong className="font-extrabold break-all text-ink">{email}</strong>. It can take a minute; check spam too.
          </p>
          <Field label="Sign-in code">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={10}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="gauge-m text-[26px] tracking-[0.2em]"
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" block disabled={busy || code.length < 6}>
            {busy ? 'Checking…' : 'Sign in'}
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="ghost" icon={RefreshCw} block onClick={resend} disabled={busy}>
              Send a new code
            </Button>
            <Button variant="ghost" block onClick={() => setStage('email')} disabled={busy}>
              Use a different email
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

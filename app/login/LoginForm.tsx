'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/browser';
import { Alert, Button, Field, Input } from '@/components/ui';

// Email one-time code. The 6-digit code works inside the installed PWA, where a magic link
// would open a separate browser tab. The email also contains a link for desktop use.
export function LoginForm({ next, initialError }: { next: string; initialError: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}` },
    });
    setBusy(false);
    if (error) setError(error.message.includes('Signups not allowed') ? 'That email is not on the team. Ask the owner for an invite.' : error.message);
    else setStage('code');
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (error) setError('That code did not work. Check it or send a new one.');
    else {
      router.replace(next);
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="red">{error}</Alert> : null}
      {stage === 'email' ? (
        <form onSubmit={sendCode} className="space-y-4">
          <Field label="Work email">
            <Input type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" disabled={busy || !email}>
            {busy ? 'Sending…' : 'Email me a sign-in code'}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-4">
          <p className="text-sm text-slate-600">We sent a 6-digit code to <strong>{email}</strong>.</p>
          <Field label="Sign-in code">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={10} required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" disabled={busy || code.length < 6}>
            {busy ? 'Checking…' : 'Sign in'}
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => setStage('email')}>
            Use a different email
          </Button>
        </form>
      )}
    </div>
  );
}

import type { Metadata } from 'next';
import { DEMO_ACCOUNTS, demoEnabled, type DemoRole } from '@/lib/demo/accounts';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-700 text-2xl font-bold text-white">K</div>
        <h1 className="text-2xl font-bold">Koala Estimator</h1>
        <p className="text-slate-600">Koala Insulation of Newark</p>
      </div>
      {demoEnabled() ? (
        <section className="mb-8 space-y-3" aria-labelledby="demo">
          <h2 id="demo" className="text-center text-sm font-semibold uppercase tracking-wide text-slate-500">
            Demo: tap to sign in as
          </h2>
          {(Object.keys(DEMO_ACCOUNTS) as DemoRole[]).map((role) => {
            const a = DEMO_ACCOUNTS[role];
            return (
              <form key={role} action="/auth/demo" method="post">
                <input type="hidden" name="as" value={role} />
                <button className="w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 hover:bg-brand-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
                  <span className="block font-semibold text-slate-900">
                    {a.label} · {a.who}
                  </span>
                  <span className="block text-sm text-slate-600">{a.blurb}</span>
                </button>
              </form>
            );
          })}
          <p className="pt-2 text-center text-xs text-slate-500">Team members sign in with an email code below.</p>
        </section>
      ) : null}
      <LoginForm next={safeNext} initialError={error ?? null} />
    </main>
  );
}

import type { Metadata } from 'next';
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
      <LoginForm next={safeNext} initialError={error ?? null} />
    </main>
  );
}

import Link from 'next/link';
import type { SessionProfile } from '@/lib/server/auth';
import { SignOutButton } from './SignOutButton';

export function AppNav({ profile }: { profile: SessionProfile }) {
  const links = [
    { href: '/field', label: 'Field app', roles: ['owner', 'office', 'estimator'] },
    { href: '/estimates', label: 'Estimates', roles: ['owner', 'office', 'estimator'] },
    { href: '/jobs', label: 'Jobs', roles: ['owner', 'office'] },
    { href: '/admin/pricing', label: 'Pricing', roles: ['owner', 'office'] },
    { href: '/admin/learning', label: 'Learning', roles: ['owner', 'office'] },
    { href: '/admin/team', label: 'Team', roles: ['owner'] },
  ].filter((l) => l.roles.includes(profile.role));
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold text-brand-800">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 text-white">K</span>
          Koala Estimator
        </Link>
        <nav className="flex flex-1 flex-wrap gap-1 text-sm">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="rounded-lg px-3 py-2 font-medium text-slate-700 hover:bg-slate-100">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <span>
            {profile.fullName} · <span className="capitalize">{profile.role}</span>
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

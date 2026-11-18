// HOW A PAGE PLUGS INTO THE APP SHELL
//
// The shell (menu, tab bar, sidebar, account menu) comes from the section's layout, never from
// the page. Every staff section has one:
//
//   app/estimates/layout.tsx   <StaffShell register="quiet">{children}</StaffShell>
//   app/jobs/, app/admin/      the same, quiet
//   app/field/, app/crew/      <StaffShell>{children}</StaffShell>   (field register)
//   app/design/                <StaffShell>{children}</StaffShell>
//
// A new staff page under one of these folders gets the shell for free. A new section adds a
// layout like the ones above and an entry in lib/nav.ts (the test there checks the page's
// requireRole(...) lets the role in).
//
//   Page title   the page's own <h1>; use <PageHeader title="Jobs" actions={…} back={…} />
//                from '@/components/shell'. The browser tab title comes from
//                `export const metadata = { title: 'Jobs' }` ("Jobs · Koala Estimator").
//   Actions      PageHeader's `actions` slot (right of the title on desktops, under it on
//                phones). The one main action of a phone screen goes in a <Dock> instead: it
//                sits above the tab bar by itself.
//   Tab bar      useHideTabBar(true) from '@/components/shell' hides it while a screen needs the
//                whole bottom edge (the field app does while an estimate is open). Fixed bottom
//                bars that are not a <Dock> use the `shell-dock` class (app/globals.css).
//   Register     the layout's `register` prop. 'quiet' for office and admin screens; the field
//                register (the default) for estimator and crew phone screens. The menu itself
//                does not change with the page's register.
//   No <main>    the shell does not render <main>; each page renders exactly one.
import 'server-only';
import { cache, type ReactNode } from 'react';
import pkg from '@/package.json';
import { menuFor } from '@/lib/nav';
import type { Role } from '@/lib/pricing';
import { getSessionProfile } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from './AppShell';
import type { ShellOrg } from './parts';

const NO_ORG: ShellOrg = { company: null, phone: null };

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The franchise's name and office phone from its branding settings, for the menu and its help
 * line. Crews cannot read settings (RLS), so theirs is read with the service client: only these
 * two branding fields, which every customer quote shows anyway. Missing or unreadable: nothing.
 */
const loadOrg = cache(async (role: Role): Promise<ShellOrg> => {
  try {
    const db = role === 'crew' ? createAdminClient() : await createClient();
    const { data, error } = await db.from('app_settings').select('value').eq('key', 'branding').maybeSingle();
    if (error || !data || typeof data.value !== 'object' || data.value === null) return NO_ORG;
    const b = data.value as Record<string, unknown>;
    return { company: text(b.company), phone: text(b.phone) };
  } catch {
    return NO_ORG;
  }
});

/** The app version people can quote when they ask for help. */
const VERSION = text(pkg.version) ?? 'unknown';

export async function StaffShell({ children, register }: { children: ReactNode; register?: 'quiet' }) {
  const profile = await getSessionProfile();
  // Signed out (the page redirects to sign-in) or no profile: no menu to show.
  if (!profile) return <div data-register={register}>{children}</div>;
  const org = await loadOrg(profile.role);
  return (
    <AppShell
      profile={{ fullName: profile.fullName, email: profile.email, role: profile.role }}
      menu={menuFor(profile.role)}
      org={org}
      version={VERSION}
      register={register}
    >
      {children}
    </AppShell>
  );
}

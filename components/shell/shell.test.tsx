// The app shell renders each role's own menu, and every staff page gets the account menu with the
// theme switch and Sign out (the field and crew apps had neither).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { menuFor } from '@/lib/nav';
import type { Role } from '@/lib/pricing';
import { AppShell } from './AppShell';
import { PageHeader } from './PageHeader';

function shell(role: Role, org = { company: null as string | null, phone: null as string | null }) {
  return renderToStaticMarkup(
    <AppShell profile={{ fullName: 'Pat Person', email: 'pat@example.com', role }} menu={menuFor(role)} org={org} version="9.9.9">
      <main>
        <h1>Page</h1>
      </main>
    </AppShell>,
  );
}
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h !== '#main-content');

describe('the app shell', () => {
  it('gives every role the account menu: theme, help, version and Sign out', () => {
    for (const role of ['owner', 'office', 'estimator', 'crew'] as Role[]) {
      const html = shell(role);
      expect(html, role).toContain('action="/auth/signout"');
      expect(html, role).toMatch(/>Sign out</);
      for (const theme of ['Auto', 'Day', 'Night', 'Sun+']) expect(html, `${role} ${theme}`).toContain(`>${theme}<`);
      expect(html, role).toContain('version 9.9.9');
      expect(html, role).toContain('Need help?');
    }
  });

  it('shows a crew only their jobs', () => {
    const html = shell('crew');
    expect(new Set(hrefs(html))).toEqual(new Set(['/crew']));
    expect(html).toContain('>Me<');
    expect(html).not.toMatch(/\$\s?\d/);
  });

  it('shows the owner every office page, and Design only in the account menu', () => {
    const html = shell('owner');
    for (const href of ['/estimates', '/field', '/field/roof', '/jobs', '/admin/pricing', '/admin/learning', '/admin/team', '/design']) expect(hrefs(html)).toContain(href);
    expect(html).toContain('>Insights<');
    expect(html).not.toContain('>Learning<');
    const sidebar = html.slice(html.indexOf('data-shell-sidebar'), html.indexOf('data-shell-content'));
    expect(sidebar).not.toContain('href="/design"');
  });

  it('never offers an office user the Team page', () => {
    expect(hrefs(shell('office'))).not.toContain('/admin/team');
  });

  it('gives the estimator Estimates and Roof lookup tabs, and All my estimates under More', () => {
    const html = shell('estimator');
    const tabbar = html.slice(html.indexOf('data-shell-tabbar'));
    expect(tabbar.indexOf('>Estimates<')).toBeGreaterThan(-1);
    expect(tabbar.indexOf('>Roof lookup<')).toBeGreaterThan(tabbar.indexOf('>Estimates<'));
    expect(tabbar).toContain('>More<');
    expect(html).toContain('>All my estimates<');
  });

  it('reads the company and office phone from settings, never from the code', () => {
    const none = shell('estimator');
    expect(none).toContain('Need help? Ask the office.');
    const html = shell('estimator', { company: 'Sample Insulation Co', phone: '(555) 010-2030' });
    expect(html).toContain('Sample Insulation Co');
    expect(html).toContain('href="tel:5550102030"');
  });

  it('wraps the page without adding a second <main>, in the register the layout asks for', () => {
    const html = renderToStaticMarkup(
      <AppShell profile={{ fullName: 'Pat', email: null, role: 'owner' }} menu={menuFor('owner')} org={{ company: null, phone: null }} version="1" register="quiet">
        <main>x</main>
      </AppShell>,
    );
    expect(html.match(/<main/g)?.length).toBe(1);
    expect(html).toMatch(/id="main-content"[^>]*data-register="quiet"/);
    expect(html).toContain('href="#main-content"');
  });
});

describe('PageHeader', () => {
  it('names Back by where it goes and keeps one h1', () => {
    const html = renderToStaticMarkup(<PageHeader title="Pat Lee" back={{ href: '/jobs', label: 'Jobs' }} actions={<button>Save</button>} />);
    expect(html).toContain('href="/jobs"');
    expect(html).toMatch(/>Jobs<\/a>/);
    expect(html.match(/<h1/g)?.length).toBe(1);
  });
});

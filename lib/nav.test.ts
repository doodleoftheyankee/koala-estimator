import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Role } from '@/lib/pricing';
import { activeHref, allItems, initials, isWithin, menuFor, moreItems, phoneTabs } from './nav';

const ROLES: Role[] = ['owner', 'office', 'estimator', 'crew'];
const ROOT = join(import.meta.dirname, '..');

/** The roles a page lets in, read from its own requireRole(...) call. */
function pageRoles(href: string): Role[] {
  const file = join(ROOT, 'app', ...href.split('/').filter(Boolean), 'page.tsx');
  expect(existsSync(file), `${href} has a page at ${file}`).toBe(true);
  const call = readFileSync(file, 'utf8').match(/requireRole\(([^)]*)\)/);
  expect(call, `${href} checks the role with requireRole(...)`).not.toBeNull();
  const roles = [...call![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1] as Role);
  return roles.length ? roles : ROLES; // requireRole() with no roles lets every signed-in role in
}

describe('the app menu', () => {
  it.each(ROLES)('never offers %s a page that sends them away', (role) => {
    for (const item of allItems(menuFor(role))) {
      expect(pageRoles(item.href), `${role} → ${item.href}`).toContain(role);
    }
  });

  it('gives each page one name per role, and each name one page', () => {
    for (const role of ROLES) {
      const items = allItems(menuFor(role));
      expect(new Set(items.map((i) => i.href)).size, role).toBe(items.length);
      expect(new Set(items.map((i) => i.label)).size, role).toBe(items.length);
    }
  });

  it('uses the names people know, with Learning now called Insights', () => {
    const owner = allItems(menuFor('owner')).map((i) => `${i.label} ${i.href}`);
    expect(owner).toEqual([
      'Estimates /estimates',
      'Field app /field',
      'Roof lookup /field/roof',
      'Jobs /jobs',
      'Pricing /admin/pricing',
      'Business profile /admin/business',
      'Insights /admin/learning',
      'Team /admin/team',
      'Design /design',
    ]);
    expect(allItems(menuFor('office')).map((i) => i.label)).not.toContain('Team');
    expect(menuFor('owner').account.map((i) => i.label)).toEqual(['Design']);
    expect(allItems(menuFor('estimator')).map((i) => `${i.label} ${i.href}`)).toEqual(['Estimates /field', 'Roof lookup /field/roof', 'All my estimates /estimates']);
    expect(allItems(menuFor('crew')).map((i) => `${i.label} ${i.href}`)).toEqual(['Jobs /crew']);
    for (const role of ROLES) expect(allItems(menuFor(role)).map((i) => i.label)).not.toContain('Learning');
  });

  it('fits a phone: at most four tabs including More / Me, and nothing lost', () => {
    for (const role of ROLES) {
      const menu = menuFor(role);
      expect(phoneTabs(menu).length + 1, role).toBeLessThanOrEqual(4);
      expect(phoneTabs(menu).length, role).toBeGreaterThan(0);
      expect([...phoneTabs(menu), ...moreItems(menu)].map((i) => i.href).sort(), role).toEqual(allItems(menu).map((i) => i.href).sort());
    }
    expect(phoneTabs(menuFor('estimator')).map((i) => i.label)).toEqual(['Estimates', 'Roof lookup']);
    expect(menuFor('crew').moreLabel).toBe('Me');
  });

  it('marks only the offline app shells (public/sw.js) as working with no signal', () => {
    const sw = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
    const shells = JSON.parse(sw.match(/const SHELLS = (\[[^\]]*\])/)![1]!.replace(/'/g, '"')) as string[];
    for (const role of ROLES) {
      for (const item of allItems(menuFor(role))) expect(Boolean(item.offline), `${role} ${item.href}`).toBe(shells.includes(item.href));
    }
  });

  it('crews see only their jobs: no page in their menu shows prices', () => {
    expect(allItems(menuFor('crew')).map((i) => i.href)).toEqual(['/crew']);
  });
});

describe('the current page', () => {
  const owner = allItems(menuFor('owner'));
  it('picks the most specific entry', () => {
    expect(activeHref('/field/roof', owner)).toBe('/field/roof');
    expect(activeHref('/field', owner)).toBe('/field');
    expect(activeHref('/jobs/1b2c', owner)).toBe('/jobs');
    expect(activeHref('/admin/learning', owner)).toBe('/admin/learning');
    expect(activeHref('/design', owner)).toBe('/design');
  });
  it('is none for a page outside the menu, and never a look-alike prefix', () => {
    expect(activeHref('/crew', owner)).toBeNull();
    expect(activeHref('/jobsite', owner)).toBeNull();
    expect(isWithin('/estimates', '/estimates')).toBe(true);
    expect(isWithin('/estimatesx', '/estimates')).toBe(false);
  });
  it('maps the estimator’s two lists apart', () => {
    const est = allItems(menuFor('estimator'));
    expect(activeHref('/field', est)).toBe('/field');
    expect(activeHref('/estimates', est)).toBe('/estimates');
  });
});

describe('initials', () => {
  it('takes the first and last name', () => {
    expect(initials('Olivia Owner')).toBe('OO');
    expect(initials('  eddie  van estimator ')).toBe('EE');
    expect(initials('Cher')).toBe('C');
    expect(initials('')).toBe('?');
  });
});

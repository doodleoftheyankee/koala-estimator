// The staff app menu: which pages each role sees, what each page is called, and where it sits.
// One list drives the desktop sidebar, the phone tab bar and the More sheet
// (components/shell/AppShell.tsx), so the names stay the same everywhere.
//
// Rules:
//  - A role only sees pages it can open. lib/nav.test.ts checks every entry against the page's
//    own requireRole(...) call, so the menu never offers a page that sends the role away.
//  - One name per page. "Estimates" is the office list for owner and office, and the estimates on
//    this phone for an estimator (their everyday list); the estimator's server list is
//    "All my estimates". The page once called "Learning" is "Insights".
//  - Phones get at most four tabs (a 390px phone fits four 15px labels); the rest of the role's
//    pages and the account menu sit behind the last tab ("More", or "Me" when there is nothing
//    else to show).
import type { Role } from '@/lib/pricing';

export type NavIcon = 'estimates' | 'allEstimates' | 'field' | 'roof' | 'jobs' | 'pricing' | 'business' | 'insights' | 'team' | 'design';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** On a phone: a bottom tab, or a row in the More sheet. */
  phone: 'tab' | 'more';
  /** Sidebar group: a rule separates the groups. */
  group: 'work' | 'admin';
  /** One plain line under the label in the More sheet. */
  hint?: string;
  /**
   * The page opens with no signal (an app shell the service worker keeps, public/sw.js). Links to
   * it are plain page loads, so the service worker can serve the saved copy. Other pages need a
   * signal; offline, the menu says so instead of opening a browser error.
   */
  offline?: boolean;
}

export interface RoleMenu {
  /** The role in words, for the account menu. */
  roleLabel: string;
  /** Sidebar order; the phone tabs are the `phone: 'tab'` items in this order. */
  main: NavItem[];
  /** Staff tools that live in the account menu, not the main menu. */
  account: NavItem[];
  /** The last phone tab, which opens the account menu. */
  moreLabel: 'More' | 'Me';
}

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', office: 'Office', estimator: 'Estimator', crew: 'Crew' };

const OFFICE_ESTIMATES: NavItem = { href: '/estimates', label: 'Estimates', icon: 'estimates', phone: 'tab', group: 'work', hint: 'Every estimate and quote' };
const FIELD_APP: NavItem = { href: '/field', label: 'Field app', icon: 'field', phone: 'tab', group: 'work', hint: 'Estimates on this phone, with or without signal', offline: true };
const ROOF_LOOKUP: NavItem = { href: '/field/roof', label: 'Roof lookup', icon: 'roof', phone: 'more', group: 'work', hint: 'Measure any roof from the satellite photo', offline: true };
const JOBS: NavItem = { href: '/jobs', label: 'Jobs', icon: 'jobs', phone: 'tab', group: 'work', hint: 'Schedule crews and check their actuals' };
const PRICING: NavItem = { href: '/admin/pricing', label: 'Pricing', icon: 'pricing', phone: 'more', group: 'admin', hint: 'Prices, materials, crews and quote text' };
const BUSINESS: NavItem = { href: '/admin/business', label: 'Business profile', icon: 'business', phone: 'more', group: 'admin', hint: 'Name, phone, license, warranty and terms on every quote' };
const INSIGHTS: NavItem = { href: '/admin/learning', label: 'Insights', icon: 'insights', phone: 'more', group: 'admin', hint: 'How finished jobs compare with their estimates' };
const TEAM: NavItem = { href: '/admin/team', label: 'Team', icon: 'team', phone: 'more', group: 'admin', hint: 'Invite people and set their crews' };
const DESIGN: NavItem = { href: '/design', label: 'Design', icon: 'design', phone: 'more', group: 'admin', hint: 'Every colour, size and part of the app' };

const MENUS: Record<Role, RoleMenu> = {
  owner: {
    roleLabel: ROLE_LABELS.owner,
    main: [OFFICE_ESTIMATES, FIELD_APP, ROOF_LOOKUP, JOBS, PRICING, BUSINESS, INSIGHTS, TEAM],
    account: [DESIGN],
    moreLabel: 'More',
  },
  office: {
    roleLabel: ROLE_LABELS.office,
    main: [OFFICE_ESTIMATES, FIELD_APP, ROOF_LOOKUP, JOBS, PRICING, BUSINESS, INSIGHTS],
    account: [DESIGN],
    moreLabel: 'More',
  },
  estimator: {
    roleLabel: ROLE_LABELS.estimator,
    main: [
      { href: '/field', label: 'Estimates', icon: 'estimates', phone: 'tab', group: 'work', hint: 'Estimates on this phone, with or without signal', offline: true },
      { ...ROOF_LOOKUP, phone: 'tab' },
      { href: '/estimates', label: 'All my estimates', icon: 'allEstimates', phone: 'more', group: 'work', hint: 'Every estimate you have synced, with quote PDFs' },
    ],
    account: [],
    moreLabel: 'More',
  },
  crew: {
    roleLabel: ROLE_LABELS.crew,
    main: [{ href: '/crew', label: 'Jobs', icon: 'jobs', phone: 'tab', group: 'work', hint: 'Your crew’s jobs, with or without signal', offline: true }],
    account: [],
    moreLabel: 'Me',
  },
};

export function menuFor(role: Role): RoleMenu {
  return MENUS[role];
}

/** Every page in a role's menu, main and account. */
export function allItems(menu: RoleMenu): NavItem[] {
  return [...menu.main, ...menu.account];
}

/** The phone tabs (before the More / Me tab). */
export function phoneTabs(menu: RoleMenu): NavItem[] {
  return menu.main.filter((i) => i.phone === 'tab');
}

/** What sits behind the More / Me tab on a phone: the rest of the main menu, then the account tools. */
export function moreItems(menu: RoleMenu): NavItem[] {
  return [...menu.main.filter((i) => i.phone === 'more'), ...menu.account];
}

/** True when `pathname` is the page at `href` or one of its sub-pages (/jobs/123 is in /jobs). */
export function isWithin(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href.endsWith('/') ? href : `${href}/`);
}

/**
 * The menu entry for the page on screen: the most specific match, so /field/roof is Roof lookup,
 * not Field app. Null when the page is not in the role's menu (an owner on /crew).
 */
export function activeHref(pathname: string, items: readonly NavItem[]): string | null {
  let best: string | null = null;
  for (const item of items) if (isWithin(pathname, item.href) && (best === null || item.href.length > best.length)) best = item.href;
  return best;
}

/** Initials for the account button: "Olivia Owner" → "OO", "cher" → "C". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]! : '';
  return (Array.from(first)[0]! + (last ? Array.from(last)[0]! : '')).toUpperCase();
}

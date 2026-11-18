'use client';
// The staff app shell: one menu for every role (owner, office, estimator, crew).
//
//   Phones     a bottom tab bar (64px plus the safe area): up to three of the role's pages and a
//              More / Me tab that opens the account menu (the rest of the pages, theme, help,
//              about, sign out). The current page's tab is solid ink.
//   1024px+    a left sidebar in the quiet register: product name, the role's pages, and the
//              account button at the bottom.
//
// Pages do not render it themselves: a section layout wraps them in <StaffShell> (server), which
// loads the profile and renders this. How a page plugs in (title, actions, hiding the tab bar,
// register) is written at the top of components/shell/StaffShell.tsx.
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { activeHref, allItems, moreItems, phoneTabs, type NavItem, type RoleMenu } from '@/lib/nav';
import { cx } from '../daymark/cx';
import { Monogram } from '../daymark/Brand';
import { ChevronsUpDown, Icon, Menu, User } from '../daymark/icons';
import { AccountMenu } from './AccountMenu';
import { Avatar, NAV_ICONS, ShellLink, type ShellOrg, type ShellProfile } from './parts';

// ---------------------------------------------------------------------------------------------
// What a page can ask of the shell
// ---------------------------------------------------------------------------------------------

interface ShellApi {
  /** Hides the phone tab bar until the returned function is called. */
  hideTabBar: () => () => void;
}
const ShellContext = createContext<ShellApi | null>(null);

/**
 * Hides the phone tab bar while `hidden` is true, so a screen's own bottom dock has the room (the
 * field app does this while an estimate is open). Outside the shell it does nothing.
 */
export function useHideTabBar(hidden: boolean): void {
  const shell = useContext(ShellContext);
  useEffect(() => {
    if (!shell || !hidden) return;
    return shell.hideTabBar();
  }, [shell, hidden]);
}

/** True inside the app shell. */
export function useInShell(): boolean {
  return useContext(ShellContext) !== null;
}

// ---------------------------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------------------------

export function AppShell({
  profile,
  menu,
  org,
  version,
  register,
  children,
}: {
  profile: ShellProfile;
  menu: RoleMenu;
  org: ShellOrg;
  version: string;
  /** The page's register: 'quiet' for office screens; the field register when left out. */
  register?: 'quiet';
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const [hiders, setHiders] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const hideTabBar = useCallback(() => {
    setHiders((n) => n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      setHiders((n) => n - 1);
    };
  }, []);
  const api = useMemo(() => ({ hideTabBar }), [hideTabBar]);

  // A new page closes the account menu.
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMenuOpen(false);
  }

  const current = activeHref(pathname, allItems(menu));
  const tabs = phoneTabs(menu);
  const more = moreItems(menu);
  const currentInMore = more.find((i) => i.href === current) ?? null;
  const openMenu = () => setMenuOpen(true);

  return (
    <ShellContext.Provider value={api}>
      <a
        href="#main-content"
        className="sr-only z-[70] rounded-control bg-surface px-4 py-3 font-bold text-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <div
        data-shell-sidebar
        data-register="quiet"
        className="fixed inset-y-0 left-0 z-40 hidden w-[var(--sidebar-w)] flex-col border-r-[length:var(--bw)] border-solid border-edge bg-surface text-ink lg:flex print:hidden"
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-4">
          <Monogram size={40} label="" />
          <div className="min-w-0">
            <p className="text-[18px] leading-tight font-extrabold tracking-[-0.01em]">Koala Estimator</p>
            {org.company ? <p className="line-clamp-2 text-[15px] leading-snug font-medium text-ink-3">{org.company}</p> : null}
          </div>
        </div>
        <nav aria-label="Main menu" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <SidebarList items={menu.main} current={current} />
        </nav>
        <div className="border-t-[length:var(--bw)] border-solid border-line p-3">
          <button
            type="button"
            onClick={openMenu}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            className="flex min-h-14 w-full items-center gap-3 rounded-control px-2 py-2 text-left hover:bg-sunken"
          >
            <Avatar name={profile.fullName} />
            <span className="min-w-0 flex-1">
              <span className="sr-only">Account menu: </span>
              <span className="block truncate text-[16px] font-bold">{profile.fullName}</span>
              <span className="block truncate text-[15px] font-medium text-ink-3">{menu.roleLabel}</span>
            </span>
            <Icon icon={ChevronsUpDown} size="s" className="text-ink-2" />
          </button>
        </div>
      </div>

      {/* The page */}
      <div
        id="main-content"
        tabIndex={-1}
        data-shell-content
        data-register={register}
        className="min-h-dvh pb-[var(--shell-bottom)] outline-none lg:pl-[var(--shell-left)] print:p-0"
      >
        {children}
      </div>

      {/* Phone tab bar */}
      <nav
        data-shell-tabbar
        hidden={hiders > 0}
        aria-label="Main menu"
        className="fixed inset-x-0 bottom-0 z-40 border-t-[length:var(--bw-x)] border-solid border-rule bg-surface pb-[var(--safe-bottom)] text-ink lg:hidden print:hidden"
      >
        <ul className="mx-auto flex h-[var(--tabbar-h)] max-w-2xl items-stretch gap-1.5 px-2 py-1">
          {tabs.map((item) => (
            <li key={item.href} className="min-w-0 flex-1">
              <ShellLink item={item} current={current === item.href} className={tabClass(current === item.href)}>
                <Icon icon={NAV_ICONS[item.icon]} />
                <span className="max-w-full truncate">{item.label}</span>
              </ShellLink>
            </li>
          ))}
          <li className="min-w-0 flex-1">
            <button type="button" onClick={openMenu} aria-haspopup="dialog" aria-expanded={menuOpen} className={tabClass(Boolean(currentInMore))}>
              <Icon icon={menu.moreLabel === 'Me' ? User : Menu} />
              <span className="max-w-full truncate">{menu.moreLabel}</span>
              {currentInMore ? <span className="sr-only">, you are on {currentInMore.label}</span> : null}
            </button>
          </li>
        </ul>
      </nav>

      <AccountMenu open={menuOpen} onClose={() => setMenuOpen(false)} profile={profile} menu={menu} org={org} version={version} current={current} />
    </ShellContext.Provider>
  );
}

function tabClass(current: boolean): string {
  return cx(
    'flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-control px-1 text-[15px] leading-tight font-bold',
    current ? 'bg-ink text-on-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
  );
}

function SidebarList({ items, current }: { items: NavItem[]; current: string | null }) {
  const groups = [items.filter((i) => i.group === 'work'), items.filter((i) => i.group === 'admin')].filter((g) => g.length > 0);
  return (
    <>
      {groups.map((group, gi) => (
        <ul key={gi} className={cx('space-y-1', gi > 0 && 'mt-3 border-t-[length:var(--bw)] border-solid border-line pt-3')}>
          {group.map((item) => {
            const on = current === item.href;
            return (
              <li key={item.href}>
                <ShellLink
                  item={item}
                  current={on}
                  className={cx(
                    'flex min-h-12 items-center gap-3 rounded-control px-3 text-[16px] font-bold',
                    on ? 'bg-ink text-on-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
                  )}
                >
                  <Icon icon={NAV_ICONS[item.icon]} />
                  {item.label}
                </ShellLink>
              </li>
            );
          })}
        </ul>
      ))}
    </>
  );
}

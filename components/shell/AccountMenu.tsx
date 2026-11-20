'use client';
// The account menu, on every staff page: who is signed in, the rest of the role's pages (phones),
// the theme, staff tools (Design), "Change my PIN" for someone who signs in with a PIN, a help
// line, About, and Sign out. A bottom sheet on phones; on a desktop it opens beside the sidebar.
import { Sheet } from '../daymark/Sheet';
import { ThemeSwitcher } from '../daymark/Theme';
import { cx } from '../daymark/cx';
import { ChevronRight, Icon, Info, LifeBuoy } from '../daymark/icons';
import { SignOutButton } from '../SignOutButton';
import { ChangePin } from './ChangePin';
import { formatPhone } from '@/lib/format';
import { moreItems, type NavItem, type RoleMenu } from '@/lib/nav';
import { Avatar, NAV_ICONS, ShellLink, useShellOnline, type ShellOrg, type ShellProfile } from './parts';

export function AccountMenu({
  open,
  onClose,
  profile,
  menu,
  org,
  version,
  current,
  register,
}: {
  open: boolean;
  onClose: () => void;
  profile: ShellProfile;
  menu: RoleMenu;
  org: ShellOrg;
  version: string;
  current: string | null;
  /** The page's register: office screens open the menu in the quiet register too. */
  register?: 'quiet';
}) {
  const online = useShellOnline();
  // Phones: the pages that are not tabs. Desktops show the main menu in the sidebar, so only the
  // account tools (Design) are listed here.
  const phonePages = moreItems(menu).filter((i) => !menu.account.includes(i));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      register={register}
      title="Menu"
      className="lg:top-auto lg:right-auto lg:bottom-4 lg:left-[calc(var(--sidebar-w)+12px)] lg:m-0 lg:max-h-[calc(100dvh-32px)] lg:w-[400px] lg:max-w-[400px] lg:rounded-sheet lg:border-b-[length:var(--bw)]"
      footer={
        <div className="space-y-2">
          <SignOutButton block disabled={!online} />
          {!online ? <p className="text-[15px] font-semibold text-ink-2">Signing out needs a signal. Your work stays saved on this phone.</p> : null}
        </div>
      }
    >
      <div className="space-y-6">
        <section aria-label="Signed in as" className="flex items-center gap-3">
          <Avatar name={profile.fullName} size={48} />
          <div className="min-w-0">
            <p className="truncate text-[20px] leading-tight font-extrabold">{profile.fullName}</p>
            <p className="truncate text-[15px] font-medium text-ink-2">
              {menu.roleLabel}
              {profile.email ? ` · ${profile.email}` : ''}
            </p>
            {org.company ? <p className="truncate text-[15px] font-medium text-ink-3">{org.company}</p> : null}
          </div>
        </section>

        {profile.pinLogin ? <ChangePin online={online} /> : null}

        {phonePages.length ? (
          <nav aria-label="More pages" className="lg:hidden">
            <MenuRows items={phonePages} current={current} onNavigate={onClose} />
          </nav>
        ) : null}

        <ThemeSwitcher />

        {menu.account.length ? (
          <nav aria-label="Staff tools">
            <MenuRows items={menu.account} current={current} onNavigate={onClose} />
          </nav>
        ) : null}

        <section aria-label="Help and about" className="space-y-3 text-[15px] font-medium text-ink-2">
          <p className="flex gap-2.5">
            <Icon icon={LifeBuoy} size="s" className="mt-0.5 text-ink" />
            <span>
              <HelpLine role={profile.role} phone={org.phone} />
            </span>
          </p>
          <p className="flex gap-2.5">
            <Icon icon={Info} size="s" className="mt-0.5 text-ink" />
            <span>
              Koala Estimator, version {version}
            </span>
          </p>
        </section>
      </div>
    </Sheet>
  );
}

function HelpLine({ role, phone }: { role: ShellProfile['role']; phone: string | null }) {
  if (role === 'owner') return <>Need help? Prices and quote text are under Pricing; people and crews are under Team.</>;
  if (role === 'office') return <>Need help? Ask the owner.</>;
  if (!phone) return <>Need help? Ask the office.</>;
  return (
    <>
      Need help? Call the office:{' '}
      <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="font-bold text-ink underline underline-offset-4">
        {formatPhone(phone)}
      </a>
    </>
  );
}

function MenuRows({ items, current, onNavigate }: { items: NavItem[]; current: string | null; onNavigate: () => void }) {
  return (
    <ul className="overflow-hidden rounded-plate border-[length:var(--bw)] border-solid border-edge bg-surface">
      {items.map((item, i) => {
        const on = current === item.href;
        return (
          <li key={item.href} className={cx(i > 0 && 'border-t border-solid border-line')}>
            <ShellLink
              item={item}
              current={on}
              onNavigate={onNavigate}
              className={cx('flex min-h-16 items-center gap-3 px-4 py-2.5', on ? 'bg-ink text-on-ink' : 'text-ink hover:bg-sunken')}
            >
              <Icon icon={NAV_ICONS[item.icon]} />
              <span className="min-w-0 flex-1">
                <span className="block text-[17px] leading-tight font-bold">{item.label}</span>
                {item.hint ? <span className={cx('block text-[15px] leading-snug font-medium', on ? 'text-on-ink' : 'text-ink-2')}>{item.hint}</span> : null}
              </span>
              <Icon icon={ChevronRight} size="s" />
            </ShellLink>
          </li>
        );
      })}
    </ul>
  );
}

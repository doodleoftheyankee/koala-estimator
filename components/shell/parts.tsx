'use client';
// Pieces shared by the app shell and its account menu.
import Link from 'next/link';
import { useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import type { Role } from '@/lib/pricing';
import { initials, type NavIcon, type NavItem } from '@/lib/nav';
import { useToast } from '../daymark/Toast';
import { Briefcase, ChartColumn, FileText, Files, Hammer, ListChecks, Palette, Satellite, Settings, Smartphone, Users, Wind, type LucideIcon } from '../daymark/icons';

export interface ShellProfile {
  fullName: string;
  email: string | null;
  role: Role;
}

/** The franchise's own details, read from its settings (never typed into the app). */
export interface ShellOrg {
  company: string | null;
  phone: string | null;
}

export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  estimates: FileText,
  allEstimates: Files,
  field: Smartphone,
  roof: Satellite,
  blowerDoor: Wind,
  jobs: Hammer,
  pricing: Settings,
  rebates: ListChecks,
  business: Briefcase,
  insights: ChartColumn,
  team: Users,
  design: Palette,
};

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}
export function useShellOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/**
 * A menu link. Pages that open with no signal (the field and crew app shells) are plain page
 * loads so the service worker can serve its saved copy; the rest are Next links. With no signal, a
 * page that needs one says so instead of opening a browser error.
 */
export function ShellLink({
  item,
  current,
  className,
  children,
  onNavigate,
}: {
  item: NavItem;
  current: boolean;
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const toast = useToast();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!item.offline && typeof navigator !== 'undefined' && navigator.onLine === false) {
      e.preventDefault();
      onNavigate?.(); // close the menu sheet first: a modal sheet would cover the message
      toast.show({ tone: 'bad', message: `No signal. ${item.label} needs internet. Your work in the field app is saved on this phone.` });
      return;
    }
    onNavigate?.();
  };
  const shared = { className, onClick, 'aria-current': current ? ('page' as const) : undefined };
  return item.offline ? (
    <a href={item.href} {...shared}>
      {children}
    </a>
  ) : (
    <Link href={item.href} prefetch={false} {...shared}>
      {children}
    </Link>
  );
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full border-[length:var(--bw)] border-solid border-edge bg-surface font-extrabold text-ink"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}

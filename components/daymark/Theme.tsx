'use client';
// Theme choice per device: Auto (follow the phone), Day, Night, Sun+.
//
//   <ThemeSwitcher />                       the four-way control (for the account menu / Me page)
//   const { choice, resolved, setChoice } = useTheme();
//
// The choice is stored in localStorage (lib/theme.ts), applied to <html> at once, and applied
// before first paint on the next load by the inline script in app/layout.tsx.
import { useSyncExternalStore } from 'react';
import {
  applyThemeChoice,
  readThemeChoice,
  resolveTheme,
  THEME_CHOICES,
  THEME_COLORS,
  THEME_HINTS,
  THEME_LABELS,
  THEME_STORAGE_KEY,
  writeThemeChoice,
  type ResolvedTheme,
  type ThemeChoice,
} from '@/lib/theme';
import { Segmented } from './choice';
import { Contrast, Moon, Smartphone, Sun, type LucideIcon } from './icons';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function media(q: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const dark = media('(prefers-color-scheme: dark)');
  const more = media('(prefers-contrast: more)');
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === THEME_STORAGE_KEY) {
      applyThemeChoice(document.documentElement, readThemeChoice(storage()));
      cb();
    }
  };
  dark?.addEventListener('change', cb);
  more?.addEventListener('change', cb);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    dark?.removeEventListener('change', cb);
    more?.removeEventListener('change', cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** "choice|resolved", a stable string snapshot. */
function snapshot(): string {
  const choice = readThemeChoice(storage());
  const resolved = resolveTheme(choice, { dark: !!media('(prefers-color-scheme: dark)')?.matches, moreContrast: !!media('(prefers-contrast: more)')?.matches });
  return `${choice}|${resolved}`;
}

/** Points the browser-bar colour at the theme in use (the layout's media variants for Auto). */
function syncThemeColor(choice: ThemeChoice) {
  for (const meta of Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))) {
    if (!meta.dataset.auto) meta.dataset.auto = meta.content;
    meta.content = choice === 'system' ? meta.dataset.auto : THEME_COLORS[choice];
  }
}

export function setThemeChoice(choice: ThemeChoice) {
  writeThemeChoice(storage(), choice);
  applyThemeChoice(document.documentElement, choice);
  syncThemeColor(choice);
  notify();
}

export function useTheme(): { choice: ThemeChoice; resolved: ResolvedTheme; setChoice: (c: ThemeChoice) => void } {
  const snap = useSyncExternalStore(subscribe, snapshot, () => 'system|day');
  const [choice, resolved] = snap.split('|') as [ThemeChoice, ResolvedTheme];
  return { choice, resolved, setChoice: setThemeChoice };
}

const ICONS: Record<ThemeChoice, LucideIcon> = { system: Smartphone, day: Sun, night: Moon, sun: Contrast };

export function ThemeSwitcher({ className, showHint = true }: { className?: string; showHint?: boolean }) {
  const { choice, setChoice } = useTheme();
  return (
    <div className={className}>
      <Segmented
        label="Theme"
        value={choice}
        onChange={setChoice}
        options={THEME_CHOICES.map((c) => ({ value: c, label: THEME_LABELS[c], icon: ICONS[c] }))}
      />
      {showHint ? <p className="mt-1.5 text-[15px] font-medium text-ink-2">{THEME_HINTS[choice]}</p> : null}
    </div>
  );
}

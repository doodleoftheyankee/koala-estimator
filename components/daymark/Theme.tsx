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
  resolveTheme,
  THEME_CHOICES,
  THEME_HINTS,
  THEME_LABELS,
  THEME_STORAGE_KEY,
  writeThemeChoice,
  type ResolvedTheme,
  type ThemeChoice,
} from '@/lib/theme';
import { Segmented } from './choice';
import { Contrast, Moon, Smartphone, Sun, type LucideIcon } from './icons';
import { currentThemeChoice, rememberThemeChoice, syncThemeColor, themeStorage } from './ThemeRestore';

export { ThemeRestore } from './ThemeRestore';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function media(q: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const dark = media('(prefers-color-scheme: dark)');
  const more = media('(prefers-contrast: more)');
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === THEME_STORAGE_KEY) {
      // Another tab changed the theme: follow the stored choice again.
      rememberThemeChoice(null);
      applyThemeChoice(document.documentElement, currentThemeChoice());
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
  const choice = currentThemeChoice();
  const resolved = resolveTheme(choice, { dark: !!media('(prefers-color-scheme: dark)')?.matches, moreContrast: !!media('(prefers-contrast: more)')?.matches });
  return `${choice}|${resolved}`;
}

export function setThemeChoice(choice: ThemeChoice) {
  writeThemeChoice(themeStorage(), choice);
  rememberThemeChoice(choice);
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

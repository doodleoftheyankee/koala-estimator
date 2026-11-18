// Daymark theme choice, stored per device. Pure helpers plus the tiny script that applies the
// choice before first paint (app/layout.tsx), so a Night or Sun+ phone never flashes Day.
//
//   system  follow the phone: Night when it prefers dark, Sun+ when it asks for more contrast
//   day     ink on chalk (the default look)
//   night   dark, for early mornings and dim attics
//   sun     Sun+: maximum contrast for direct sun on a roof
//
// The choice lives in localStorage under THEME_STORAGE_KEY. "system" removes data-theme from
// <html> so the media queries in app/globals.css decide; any other choice sets data-theme.

export const THEME_CHOICES = ['system', 'day', 'night', 'sun'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
/** A theme that is actually on screen. */
export type ResolvedTheme = Exclude<ThemeChoice, 'system'>;

export const THEME_STORAGE_KEY = 'koala.theme';

/** Words people see for each choice. */
export const THEME_LABELS: Record<ThemeChoice, string> = { system: 'Auto', day: 'Day', night: 'Night', sun: 'Sun+' };
export const THEME_HINTS: Record<ThemeChoice, string> = {
  system: 'Follows your phone',
  day: 'Ink on light grey',
  night: 'Dark, for low light',
  sun: 'Strongest contrast, for direct sun',
};

/** Browser-bar colour per theme: the page canvas. No franchise colour. */
export const THEME_COLORS: Record<ResolvedTheme, string> = { day: '#EDEDE7', night: '#0A0B0C', sun: '#FFFFFF' };

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return typeof v === 'string' && (THEME_CHOICES as readonly string[]).includes(v);
}

/** The stored choice; "system" when nothing (or something unreadable) is stored. */
export function readThemeChoice(storage: Pick<Storage, 'getItem'> | null | undefined): ThemeChoice {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(v) ? v : 'system';
  } catch {
    return 'system'; // private mode, blocked storage
  }
}

export function writeThemeChoice(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, choice: ThemeChoice): void {
  try {
    if (choice === 'system') storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage can be blocked; the theme still applies for this visit.
  }
}

/** What "system" means right now, from the phone's preferences. */
export function resolveTheme(choice: ThemeChoice, prefs: { dark: boolean; moreContrast: boolean }): ResolvedTheme {
  if (choice !== 'system') return choice;
  if (prefs.moreContrast) return 'sun';
  return prefs.dark ? 'night' : 'day';
}

/**
 * Runs in <head> before first paint. Kept tiny and dependency-free; mirrors readThemeChoice and
 * applyThemeChoice. Any failure leaves the page on its media-query default.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=document.documentElement;var k=${JSON.stringify(THEME_COLORS)};if(k.hasOwnProperty(c)){d.setAttribute('data-theme',c);document.addEventListener('DOMContentLoaded',function(){var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].setAttribute('data-auto',m[i].content);m[i].content=k[c]}})}else{d.removeAttribute('data-theme');c='system'}d.setAttribute('data-theme-choice',c)}catch(e){}})();`;

/** Applies a choice to <html> (the same thing the init script does). */
export function applyThemeChoice(root: HTMLElement, choice: ThemeChoice): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  root.setAttribute('data-theme-choice', choice);
}

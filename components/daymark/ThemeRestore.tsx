'use client';
// The small part of the theme control that every page loads, the public quote and sign-in
// included: the no-flash script and the restore step. It imports only lib/theme, so the root
// layout does not pull the theme switcher, the choice controls or the app shell into every page.
// The switcher itself lives in ./Theme.tsx.
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { applyThemeChoice, readThemeChoice, THEME_COLORS, THEME_INIT_SCRIPT, type ThemeChoice } from '@/lib/theme';

/** localStorage, or null where the browser blocks it (private mode, blocked site data). */
export function themeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The choice made on this visit. Storage can refuse to keep it; the theme still applies for the
// rest of the visit, and the switcher must show that choice, not the stored one.
let chosenThisVisit: ThemeChoice | null = null;

/** The choice in force: the one made on this visit, else the stored one. */
export function currentThemeChoice(): ThemeChoice {
  return chosenThisVisit ?? readThemeChoice(themeStorage());
}

/** Remember a choice for this visit (null: follow storage again, e.g. after another tab changed it). */
export function rememberThemeChoice(choice: ThemeChoice | null): void {
  chosenThisVisit = choice;
}

/** Points the browser-bar colour at the theme in use (the layout's media variants for Auto). */
export function syncThemeColor(choice: ThemeChoice): void {
  for (const meta of Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))) {
    if (!meta.dataset.auto) meta.dataset.auto = meta.content;
    meta.content = choice === 'system' ? meta.dataset.auto : THEME_COLORS[choice];
  }
}

/**
 * Re-applies the stored choice once the page is running. The inline script does this before
 * first paint, but Next draws some not-found and error pages in the browser, where that script
 * never runs. A layout effect runs before the browser paints, so a Night or Sun+ phone does not
 * see one Day frame on those pages.
 */
export function ThemeRestore() {
  useLayoutEffect(() => {
    const choice = currentThemeChoice();
    if (document.documentElement.getAttribute('data-theme-choice') === choice) return;
    applyThemeChoice(document.documentElement, choice);
    syncThemeColor(choice);
  }, []);
  return null;
}

const noSubscribe = () => () => undefined;

/**
 * The no-flash script, in the server HTML only. When the browser draws a page itself (a
 * not-found or error page), React would create a <script> that never runs and warn about it;
 * ThemeRestore covers those pages instead. After hydration the spent script is dropped.
 */
export function ThemeInitScript() {
  const fromServer = useSyncExternalStore(noSubscribe, () => false, () => true);
  return fromServer ? <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /> : null;
}

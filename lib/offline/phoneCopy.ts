// Does this browser hold a saved copy of a page of the app (the service worker's shell cache,
// public/sw.js)? /unreachable offers "Open the estimates on this phone" only when it does: with no
// copy, the link would lead straight back to /unreachable (review B flow-B8).

/**
 * True when the browser's caches hold `path` (the shell the service worker saved there). False with
 * no cache storage (an insecure page, an old browser), or when reading it fails.
 */
export async function hasSavedCopy(
  path: string,
  store: Pick<CacheStorage, 'match'> | undefined = typeof caches === 'undefined' ? undefined : caches,
): Promise<boolean> {
  if (!store) return false;
  try {
    // The shell is saved under its bare path; Next's Vary headers must not hide it, and a query
    // (?job= for the blower door tool) only says what the shell opens (public/sw.js shellFor).
    return (await store.match(path, { ignoreVary: true, ignoreSearch: true })) !== undefined;
  } catch {
    return false;
  }
}

/** The phone's own copy of the app someone was opening when Koala did not answer: the link, the saved shell it opens, and its words. */
export interface PhoneApp {
  href: string;
  /** The shell the service worker saved for it (public/sw.js SHELLS). */
  copy: string;
  label: string;
}

const BLOWER_DOOR = '/field/blower-door';
const FIELD_APP: PhoneApp = { href: '/field', copy: '/field', label: 'Open the estimates on this phone' };
const CREW_APP: PhoneApp = { href: '/crew', copy: '/crew', label: 'Open the crew app on this phone' };

/**
 * The phone's own copy of the app the person was opening, which works without Koala. The blower
 * door tool is its own saved shell, for every role, crews included: it opens at the same address
 * (the same job or estimate), never the estimator's field app, which a crew phone does not have.
 */
export function phoneAppFor(next: string): PhoneApp | null {
  if (next === BLOWER_DOOR || next.startsWith(`${BLOWER_DOOR}?`) || next.startsWith(`${BLOWER_DOOR}/`)) {
    return { href: next, copy: BLOWER_DOOR, label: 'Open the blower door tool on this phone' };
  }
  if (next === '/field' || next.startsWith('/field?') || (next.startsWith('/field/') && !next.startsWith('/field/roof'))) {
    return { ...FIELD_APP };
  }
  if (next === '/crew' || next.startsWith('/crew?') || next.startsWith('/crew/')) return { ...CREW_APP };
  return null;
}

/**
 * For a page that is not one of the phone's apps (All my estimates, Jobs, Pricing, the Roof
 * lookup), the apps that work without Koala: the field app and the crew app. /unreachable offers
 * each only when this phone has it saved (flow-B8), so "Try again" is never the only way on
 * (release review C FLOW-4). Nothing for one of the apps: that app itself is offered.
 */
export function fallbackAppsFor(next: string): PhoneApp[] {
  return phoneAppFor(next) ? [] : [{ ...FIELD_APP }, { ...CREW_APP }];
}

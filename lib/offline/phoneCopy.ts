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
    // The shell is saved under its bare path; Next's Vary headers must not hide it.
    return (await store.match(path, { ignoreVary: true })) !== undefined;
  } catch {
    return false;
  }
}

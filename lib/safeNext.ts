// Where to go after signing in (?next=): only a path on this site. "/\evil.com" and "//evil.com"
// (and the same with tabs or new lines in between, which browsers drop) leave the site, so they
// fall back, and so does a path that becomes one of those once its dot segments are resolved
// ("/.//evil.com", "/a/..//evil.com", "/%2e//evil.com": review B database-B1). Anything that is not
// one string (a repeated ?next= arrives as an array) falls back too. Used by the sign-in page, the
// sign-in routes and /unreachable.

const HERE = 'http://koala.invalid';

/** "//host" or "/\host": a path that a browser reads as another site. */
const OTHER_SITE = /^\/[/\\]/;

/** `next` as a path on this site (path, query and hash), or `fallback`. */
export function safeNext(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string' || !next.startsWith('/') || OTHER_SITE.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, HERE);
  } catch {
    return fallback;
  }
  // The check above saw the raw text; the path returned is the resolved one, so check that too.
  if (url.origin !== HERE || OTHER_SITE.test(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

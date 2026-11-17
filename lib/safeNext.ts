// Where to go after signing in (?next=): only a path on this site. "/\evil.com" and "//evil.com"
// (and the same with tabs or new lines in between, which browsers drop) leave the site, so they
// fall back. Used by the sign-in page and the sign-in routes.

const HERE = 'http://koala.invalid';

/** `next` as a path on this site (path, query and hash), or `fallback`. */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || /^\/[/\\]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, HERE);
  } catch {
    return fallback;
  }
  return url.origin === HERE ? `${url.pathname}${url.search}${url.hash}` : fallback;
}

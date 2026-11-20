import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { authErrorState, PATH_HEADER, UNREACHABLE_BODY } from '@/lib/server/sessionState';

// Paths that work without a session: login, auth callbacks, the customer's quote/sign pages,
// the "can't reach Koala" page and PWA assets. Everything else requires a signed-in user.
// /api/cron/* authenticates itself with CRON_SECRET (Vercel Cron sends no session cookie).
const PUBLIC = [/^\/login/, /^\/auth\//, /^\/q\//, /^\/api\/public\//, /^\/api\/cron\//, /^\/api\/demo\//, /^\/api\/export\//, /^\/api\/photos\/read\/check$/, /^\/api\/roof\/check$/, /^\/sw\.js$/, /^\/manifest\.webmanifest$/, /^\/offline/, /^\/unreachable$/];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // Pages learn the path they were opened at from this header (lib/server/auth sends people back to
  // it). Always set here, so a value sent by the browser never reaches a page.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set(PATH_HEADER, path + request.nextUrl.search);
    return NextResponse.next({ request: { headers } });
  };
  let response = forward();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response; // misconfigured env: let the page render its own error

  const supabase = createServerClient(url, key, {
    // As lib/supabase/server.ts: no retries while Koala's database does not answer (release review C FLOW-3).
    db: { retry: false },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = forward();
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Refreshes the session cookie when needed. Do not put logic between createServerClient and getUser.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (!user && !PUBLIC.some((re) => re.test(path))) {
    // Koala could not be asked (L36): not a sign-out. Nothing goes through; pages say so on
    // /unreachable (the phone's service worker opens the field app from its own copy instead).
    if (authErrorState(error) === 'unreachable') {
      if (path.startsWith('/api/')) return NextResponse.json(UNREACHABLE_BODY, { status: 503, headers: { 'Retry-After': '30' } });
      const page = request.nextUrl.clone();
      page.pathname = '/unreachable';
      page.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
      return NextResponse.redirect(page);
    }
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = path === '/' ? '' : `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)'],
};

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Paths that work without a session: login, auth callbacks, the customer's quote/sign pages,
// and PWA assets. Everything else requires a signed-in user.
// /api/cron/* authenticates itself with CRON_SECRET (Vercel Cron sends no session cookie).
const PUBLIC = [/^\/login/, /^\/auth\//, /^\/q\//, /^\/api\/public\//, /^\/api\/cron\//, /^\/api\/demo\//, /^\/sw\.js$/, /^\/manifest\.webmanifest$/, /^\/offline/];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response; // misconfigured env: let the page render its own error

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Refreshes the session cookie when needed. Do not put logic between createServerClient and getUser.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (!user && !PUBLIC.some((re) => re.test(path))) {
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

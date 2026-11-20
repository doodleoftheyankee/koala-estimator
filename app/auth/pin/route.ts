// POST /auth/pin {id, pin, next?} (JSON, from the PIN pad on the sign-in page): signs in a person
// listed for PIN sign-in, like /auth/demo, and answers where to go: `next` when the sign-in page
// was opened for a page, else the role's home (crew: /crew, never a priced page). The session
// cookie is set on this answer; the page then opens the address.
//
// The lockout comes first and every refusal reads like a wrong PIN, so nothing says whether a name
// exists (lib/auth/pin.ts). Refusals answer 200 with { ok: false, message }: a wrong PIN is
// something the person did, not a server error, and the page shows the words as they are.
// A sign-in also sets the known-phone cookie: on this phone the person's PINs are then counted on
// their own, so a stranger who locks the name (the ids are on the sign-in page) cannot keep them out.
import { NextResponse, type NextRequest } from 'next/server';
import { checkPin, DEVICE_COOKIE, deviceCookieOptions, ENTER_PIN_MESSAGE, PIN_OFF_MESSAGE } from '@/lib/auth/pin';
import { serverEnv } from '@/lib/env';
import { roleHome } from '@/lib/nav';
import { safeNext } from '@/lib/safeNext';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const NO_STORE = { 'Cache-Control': 'no-store' };
const refuse = (message: string, kind = 'invalid') => NextResponse.json({ ok: false, kind, message }, { headers: NO_STORE });

export async function POST(request: NextRequest) {
  // JSON only: a form on another site cannot send it without the browser asking this site first.
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ ok: false, message: 'Send JSON.' }, { status: 415 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown; pin?: unknown; next?: unknown } | null;
  if (!body || typeof body !== 'object') return refuse(ENTER_PIN_MESSAGE);

  const secret = serverEnv.pinSecret();
  if (!secret) return refuse(PIN_OFF_MESSAGE, 'off');
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient({ retry: false });
  } catch {
    return refuse(PIN_OFF_MESSAGE, 'off');
  }
  const supabase = await createClient();
  const result = await checkPin(
    {
      admin,
      secret,
      signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
      device: request.cookies.get(DEVICE_COOKIE)?.value ?? null,
    },
    body.id,
    body.pin,
  );
  if (!result.ok) return refuse(result.message, result.kind);
  const next = safeNext(body.next, '/');
  const res = NextResponse.json({ ok: true, to: next === '/' ? roleHome(result.role) : next }, { headers: NO_STORE });
  res.cookies.set(DEVICE_COOKIE, result.device, deviceCookieOptions(request.nextUrl.protocol === 'https:'));
  return res;
}

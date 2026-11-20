// POST /api/account/pin {current, pin, again} (JSON, "Change my PIN" in the account menu): a
// signed-in PIN person changes their own PIN. The current PIN is checked as signing in checks it,
// and a wrong one counts toward the same lockout (lib/auth/pin.ts). Supabase signs a person out
// everywhere when their password changes, so this phone is signed in again with the new PIN right
// after (a new session cookie on this answer) and the person carries on.
// Refusals answer 200 with { ok: false, message } (words for the person, not a server error).
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { checkPin, derivedPassword, PIN_OFF_MESSAGE, setPin } from '@/lib/auth/pin';
import { newPinProblem } from '@/lib/auth/pinShared';
import { publicEnv, serverEnv } from '@/lib/env';
import { authorize } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const NO_STORE = { 'Cache-Control': 'no-store' };
const answer = (ok: boolean, message: string) => NextResponse.json({ ok, message }, { headers: NO_STORE });

export async function POST(request: Request) {
  const { profile, error } = await authorize();
  if (error) return error;
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ ok: false, message: 'Send JSON.' }, { status: 415 });
  }
  if (!profile.pinLogin) return answer(false, 'You sign in with your email, so there is no PIN to change.');
  const body = (await request.json().catch(() => null)) as { current?: unknown; pin?: unknown; again?: unknown } | null;
  const problem = newPinProblem(body?.current, body?.pin, body?.again);
  if (problem) return answer(false, problem);
  const pin = body!.pin as string;

  const secret = serverEnv.pinSecret();
  if (!secret) return answer(false, PIN_OFF_MESSAGE);
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient({ retry: false });
  } catch {
    return answer(false, PIN_OFF_MESSAGE);
  }

  // The current PIN, checked on a client that keeps no session: this phone's stays as it is.
  const check = createSupabaseClient(publicEnv.supabaseUrl(), publicEnv.supabaseAnonKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const current = await checkPin({ admin, secret, signIn: (email, password) => check.auth.signInWithPassword({ email, password }) }, profile.userId, body!.current);
  if (!current.ok) return answer(false, current.message);

  const failed = await setPin(admin, profile.userId, pin, secret);
  if (failed) return answer(false, `Your PIN was not changed: ${failed}`);

  // Signed in again with the new PIN, so this phone keeps working.
  const supabase = await createClient();
  await supabase.auth.signInWithPassword({ email: current.email, password: derivedPassword(profile.userId, pin, secret) }).catch(() => undefined);
  return answer(true, 'Your PIN is changed. Use the new one next time you sign in.');
}

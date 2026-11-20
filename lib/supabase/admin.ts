import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { publicEnv, serverEnv } from '@/lib/env';

/**
 * Service-role client. Bypasses RLS. Use only for trusted server work that the user's
 * own client is not allowed to do (writing quotes, storage, public signing page, invites),
 * and always after checking the caller's role yourself.
 */
export function createAdminClient(opts: { retry?: boolean } = {}) {
  return createClient(publicEnv.supabaseUrl(), serverEnv.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    // retry: false for a read that someone waits on and that has an answer for "Koala did not
    // answer" (the sign-in page, PIN sign-in): no 1 + 2 + 4 s of retries first (release review C FLOW-3).
    ...(opts.retry === false ? { db: { retry: false } } : {}),
  });
}

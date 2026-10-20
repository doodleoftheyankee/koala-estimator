import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { publicEnv, serverEnv } from '@/lib/env';

/**
 * Service-role client. Bypasses RLS. Use only for trusted server work that the user's
 * own client is not allowed to do (writing quotes, storage, public signing page, invites),
 * and always after checking the caller's role yourself.
 */
export function createAdminClient() {
  return createClient(publicEnv.supabaseUrl(), serverEnv.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '@/lib/env';

/**
 * Supabase client acting as the signed-in user. All queries go through RLS.
 * No retries (release review C FLOW-3): postgrest-js would retry a 503 or a failed fetch three
 * times (1, 2, then 4 s), so while Koala's database is down every page waited 7 s or more before
 * saying "Can't reach Koala right now". A page or API that cannot reach it says so at once.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(publicEnv.supabaseUrl(), publicEnv.supabaseAnonKey(), {
    db: { retry: false },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. proxy.ts refreshes the session.
        }
      },
    },
  });
}

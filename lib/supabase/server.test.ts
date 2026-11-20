// Release review C FLOW-3: while Koala's database answers 503, the signed-in user's client must
// say so at once. postgrest-js retries a 503 (and a failed fetch) three times, waiting 1, 2 and 4 s,
// so every page and API took 7 s or more to reach "Can't reach Koala right now".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const made: unknown[][] = [];
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => {
    made.push(args);
    return {};
  },
}));

describe("the signed-in user's Supabase client", () => {
  beforeEach(() => {
    made.length = 0;
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  });

  it('does not retry a database read, so a 503 reaches "unreachable" at once (release review C FLOW-3)', async () => {
    const { createClient } = await import('./server');
    await createClient();
    expect(made).toHaveLength(1);
    expect((made[0]![2] as { db?: unknown }).db).toEqual({ retry: false });
  });
});

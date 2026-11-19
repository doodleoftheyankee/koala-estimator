// Release, "blower door under the accuracy rules" (review B flow-B10, L36): saving the rebate
// programs while Koala's database or sign-in service does not answer says so. Before, the owner was
// told "Only the owner can change the rebate programs.", as if they were not allowed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
const state = vi.hoisted(() => ({ value: { state: 'ok' } as unknown, writes: 0 }));
vi.mock('@/lib/server/auth', () => ({
  getSessionState: async () => state.value,
  getSessionProfile: async () => {
    const s = state.value as { state: string; profile?: unknown };
    return s.state === 'ok' ? s.profile : null;
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      upsert: () => {
        state.writes += 1;
        return { select: async () => ({ data: [{ key: 'blower_door' }], error: null }) };
      },
    }),
  }),
}));

import { saveRebatePrograms } from './actions';
import { SEEDED } from '@/lib/blowerdoor/__fixtures__/settings';

const form = () => {
  const fd = new FormData();
  fd.set('settings', JSON.stringify(SEEDED));
  return fd;
};
const owner = { userId: '11111111-1111-4111-8111-111111111111', email: null, role: 'owner', fullName: 'Olive Owner' };

describe('saving the rebate programs', () => {
  beforeEach(() => {
    state.value = { state: 'ok', profile: owner };
    state.writes = 0;
  });

  it("Koala unreachable: \"Can't reach Koala right now. Nothing was saved.\", not \"Only the owner …\"", async () => {
    state.value = { state: 'unreachable' };
    const r = await saveRebatePrograms(null, form());
    expect(r).toMatchObject({ ok: false, error: "Can't reach Koala right now. Nothing was saved." });
    expect(state.writes).toBe(0);
  });

  it('signed out, or the office: the action\'s own words', async () => {
    state.value = { state: 'signed_out' };
    expect(await saveRebatePrograms(null, form())).toMatchObject({ ok: false, error: 'Only the owner can change the rebate programs.' });
    state.value = { state: 'ok', profile: { ...owner, role: 'office' } };
    expect(await saveRebatePrograms(null, form())).toMatchObject({ ok: false, error: 'Only the owner can change the rebate programs.' });
    expect(state.writes).toBe(0);
  });

  it('the owner saves', async () => {
    expect(await saveRebatePrograms(null, form())).toMatchObject({ ok: true, message: 'Saved 2 programs. Phones get them the next time they sync.' });
    expect(state.writes).toBe(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({ value: { state: 'ok' } as unknown }));
vi.mock('./auth', () => ({ getSessionState: async () => state.value }));

import { actionRefusal } from './actionAuth';
import { UNREACHABLE_NOT_SAVED } from './sessionState';

// Review B flow-B10: an owner saving Pricing while Koala's database did not answer was told "Only the
// owner can change pricing." The words now say what happened.
describe('a refused server action says why in words', () => {
  beforeEach(() => {
    state.value = { state: 'ok', profile: { userId: 'u', email: null, role: 'owner', fullName: 'O' } };
  });

  it("Koala unreachable: \"Can't reach Koala right now. Nothing was saved.\"", async () => {
    state.value = { state: 'unreachable' };
    expect(UNREACHABLE_NOT_SAVED).toBe("Can't reach Koala right now. Nothing was saved.");
    expect(await actionRefusal('Only the owner can change pricing.')).toBe("Can't reach Koala right now. Nothing was saved.");
  });

  it('signed out, or another role: the action\'s own words', async () => {
    state.value = { state: 'signed_out' };
    expect(await actionRefusal('Only the owner can change pricing.')).toBe('Only the owner can change pricing.');
    state.value = { state: 'ok', profile: { userId: 'u', email: null, role: 'office', fullName: 'O' } };
    expect(await actionRefusal('Only the owner can change pricing.')).toBe('Only the owner can change pricing.');
  });

  it('the server actions use it wherever they refuse a person', async () => {
    const fs = await import('node:fs');
    for (const f of ['app/admin/pricing/actions.ts', 'app/admin/team/actions.ts', 'app/admin/learning/actions.ts', 'app/jobs/actions.ts', 'app/estimates/actions.ts']) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).toContain('actionRefusal');
      // Every early "not allowed" return after a session check goes through it.
      expect(text.match(/if \(!(owner|profile|s)\b[^\n]*return failure\((NOT_OWNER|NOT_STAFF|'[^']*')\)/g) ?? [], f).toEqual([]);
    }
  });
});

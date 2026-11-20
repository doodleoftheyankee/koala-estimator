// Sign in with a name and a PIN: the PIN's shape, the password behind it, the lockout (5 wrong
// PINs in a row lock the name for 15 minutes; the right PIN starts again), the service-role reads
// and writes of pin_attempts (against an in-memory stand-in for the Supabase client), what the
// person reads, and the names on the sign-in page.
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const {
  checkPin,
  clearAttempts,
  createPinLogin,
  DEFAULT_PIN,
  derivedPassword,
  isPin,
  isPinLoginEmail,
  isUuid,
  isWrongCredentials,
  loadPinNames,
  LOCK_MINUTES,
  lockedMessage,
  MAX_TRIES,
  minutesLeft,
  PIN_LENGTH,
  pinLoginEmail,
  pinSignInList,
  releaseAttempt,
  reserveAttempt,
  setPin,
  shownEmail,
  startAttempt,
  wrongPinMessage,
} = await import('./pin');

const SECRET = 'unit-test-pin-secret';
const CREW = '0a000000-0000-4000-8000-000000000001';
const OFFICE = '0a000000-0000-4000-8000-000000000002';
const MAIL = '0a000000-0000-4000-8000-000000000003';
const OFF = '0a000000-0000-4000-8000-000000000004';
const NOBODY = '0a000000-0000-4000-8000-0000000000ff';
const T0 = new Date('2026-11-20T15:00:00.000Z');

// ---------------------------------------------------------------------------------------------
// An in-memory stand-in for the service-role client: profiles, pin_attempts (with its primary
// key and foreign key) and auth.admin. Every call waits a turn, so attempts sent side by side
// interleave as they do over the network.
// ---------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Err = { message: string; code?: string; status?: number };
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeDb() {
  const profiles = new Map<string, Row>();
  const attempts = new Map<string, Row>();
  const users = new Map<string, { id: string; email: string; password: string; user_metadata: unknown }>();
  const fail: Partial<Record<'read' | 'insert' | 'update' | 'delete' | 'profiles' | 'getUser' | 'createUser' | 'updateUser', Err>> = {};
  const calls: string[] = [];
  let ignoreGivenId = false;
  /** Runs once, between a read of pin_attempts and the next write (to stage a race). */
  let betweenReadAndWrite: (() => void) | null = null;

  function table(name: string) {
    const rows = name === 'profiles' ? profiles : attempts;
    const key = name === 'profiles' ? 'id' : 'profile_id';
    const filters: Array<(r: Row) => boolean> = [];
    let op: { kind: 'select' } | { kind: 'insert'; row: Row } | { kind: 'update'; values: Row } | { kind: 'delete' } = { kind: 'select' };
    let returning = false;
    const matches = () => [...rows.values()].filter((r) => filters.every((f) => f(r)));
    async function run(): Promise<{ data: unknown; error: Err | null }> {
      await tick();
      calls.push(`${name}.${op.kind}`);
      if (op.kind === 'select') {
        const e = name === 'profiles' ? fail.profiles : fail.read;
        if (e) return { data: null, error: e };
        const hit = matches().map((r) => ({ ...r }));
        if (name === 'pin_attempts' && betweenReadAndWrite) {
          const f = betweenReadAndWrite;
          betweenReadAndWrite = null;
          queueMicrotask(f);
        }
        return { data: hit, error: null };
      }
      if (fail[op.kind]) return { data: null, error: fail[op.kind]! };
      if (op.kind === 'insert') {
        const id = op.row[key] as string;
        if (name === 'pin_attempts' && !profiles.has(id)) return { data: null, error: { message: 'fk', code: '23503' } };
        if (rows.has(id)) return { data: null, error: { message: 'duplicate key', code: '23505' } };
        rows.set(id, { ...op.row });
        return { data: null, error: null };
      }
      const hit = matches();
      for (const r of hit) {
        if (op.kind === 'update') Object.assign(r, op.values);
        else rows.delete(r[key] as string);
      }
      return { data: returning ? hit.map((r) => ({ [key]: r[key] })) : null, error: null };
    }
    const b = {
      select() {
        if (op.kind !== 'select') returning = true;
        return b;
      },
      insert(row: Row) {
        op = { kind: 'insert', row };
        return b;
      },
      update(values: Row) {
        op = { kind: 'update', values };
        return b;
      },
      delete() {
        op = { kind: 'delete' };
        return b;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] !== null && r[col] !== undefined && String(r[col]) === String(v));
        return b;
      },
      is(col: string, v: null) {
        filters.push((r) => (r[col] ?? null) === v);
        return b;
      },
      async maybeSingle() {
        const res = await run();
        if (res.error) return res;
        const list = res.data as Row[];
        return { data: list[0] ?? null, error: null };
      },
      then<T>(ok: (v: { data: unknown; error: Err | null }) => T, bad?: (e: unknown) => T) {
        return run().then(ok, bad);
      },
    };
    return b;
  }

  const admin = {
    from: (name: string) => table(name),
    auth: {
      admin: {
        async getUserById(id: string) {
          await tick();
          if (fail.getUser) return { data: { user: null }, error: fail.getUser };
          const u = users.get(id);
          return u ? { data: { user: { id: u.id, email: u.email } }, error: null } : { data: { user: null }, error: { message: 'User not found', status: 404 } };
        },
        async createUser(a: { id?: string; email: string; password: string; user_metadata?: unknown; email_confirm?: boolean }) {
          await tick();
          calls.push(`createUser confirm=${a.email_confirm}`);
          if (fail.createUser) return { data: { user: null }, error: fail.createUser };
          const id = !ignoreGivenId && a.id ? a.id : '0b000000-0000-4000-8000-000000000099';
          users.set(id, { id, email: a.email, password: a.password, user_metadata: a.user_metadata });
          return { data: { user: { id, email: a.email } }, error: null };
        },
        async updateUserById(id: string, a: { password: string }) {
          await tick();
          calls.push(`updateUserById ${id}`);
          if (fail.updateUser) return { data: { user: null }, error: fail.updateUser };
          users.get(id)!.password = a.password;
          return { data: { user: { id } }, error: null };
        },
        async deleteUser(id: string) {
          calls.push(`deleteUser ${id}`);
          users.delete(id);
          return { data: {}, error: null };
        },
      },
    },
  };

  /** Supabase's password sign-in, as the route's cookie client would answer it. */
  const signIn = vi.fn(async (email: string, password: string): Promise<{ error: { status?: number; code?: string; message?: string } | null }> => {
    await tick();
    const u = [...users.values()].find((x) => x.email === email);
    return u && u.password === password ? { error: null } : { error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } };
  });

  function addPerson(id: string, role: string, fullName: string, opts: { pin?: string; active?: boolean; pinSignIn?: boolean; email?: string } = {}) {
    profiles.set(id, { id, role, full_name: fullName, active: opts.active ?? true, pin_sign_in: opts.pinSignIn ?? true });
    users.set(id, { id, email: opts.email ?? pinLoginEmail(id), password: derivedPassword(id, opts.pin ?? DEFAULT_PIN, SECRET), user_metadata: {} });
  }

  return {
    client: admin as unknown as SupabaseClient,
    profiles,
    attempts,
    users,
    fail,
    calls,
    signIn,
    addPerson,
    ignoreGivenId: () => (ignoreGivenId = true),
    race: (f: () => void) => (betweenReadAndWrite = f),
  };
}

const at = (minutes: number) => () => new Date(T0.getTime() + minutes * 60_000);

// ---------------------------------------------------------------------------------------------

describe('the PIN', () => {
  it('is exactly four digits, starting at 1234', () => {
    expect(PIN_LENGTH).toBe(4);
    expect(DEFAULT_PIN).toBe('1234');
    expect(isPin('1234')).toBe(true);
    expect(isPin('0000')).toBe(true);
    for (const bad of ['123', '12345', '12a4', ' 1234', '1234 ', '-123', '١٢٣٤', '', null, undefined, 1234]) expect(isPin(bad), String(bad)).toBe(false);
  });

  it('is never the Supabase password: that is base64url(HMAC-SHA256(secret, id:pin))', () => {
    const p = derivedPassword(CREW, '1234', SECRET);
    expect(p).toBe(createHmac('sha256', SECRET).update(`${CREW}:1234`).digest('base64url'));
    expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/); // 6+ characters, as Supabase needs
    expect(p).not.toContain('1234');
    expect(derivedPassword(CREW, '1235', SECRET)).not.toBe(p);
    expect(derivedPassword(OFFICE, '1234', SECRET)).not.toBe(p);
    expect(derivedPassword(CREW, '1234', 'another-secret')).not.toBe(p);
    expect(() => derivedPassword(CREW, '1234', '')).toThrow(/PIN_SECRET/);
  });

  it('logs in with a made-up example.com address the app can tell apart', () => {
    expect(pinLoginEmail(CREW)).toBe(`pin.${CREW}@example.com`);
    expect(pinLoginEmail(CREW.toUpperCase())).toBe(`pin.${CREW}@example.com`);
    expect(isPinLoginEmail(pinLoginEmail(CREW))).toBe(true);
    for (const other of ['owner.demo@example.com', 'pin.x@example.com', `pin.${CREW}@example.org`, `${CREW}@example.com`, null, undefined, ''])
      expect(isPinLoginEmail(other), String(other)).toBe(false);
    // Never shown, and never put on a customer's quote as the estimator's email.
    expect(shownEmail(pinLoginEmail(CREW))).toBeNull();
    expect(shownEmail('erin@example.com')).toBe('erin@example.com');
    expect(shownEmail(undefined)).toBeNull();
    expect(isUuid(CREW)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('the "Change my PIN" form', () => {
  it('asks for the current PIN and the same new 4-digit PIN twice, different from the current one', async () => {
    const { newPinProblem } = await import('./pinShared');
    expect(newPinProblem('1234', '2468', '2468')).toBeNull();
    expect(newPinProblem('12', '2468', '2468')).toBe('Enter your current PIN (4 digits).');
    expect(newPinProblem('1234', '246', '246')).toBe('Your new PIN must be 4 digits.');
    expect(newPinProblem('1234', '2468', '2469')).toBe("The new PINs don't match. Type the same 4 digits twice.");
    expect(newPinProblem('1234', '1234', '1234')).toBe('Your new PIN is the same as your current one.');
  });
});

describe('what the person reads', () => {
  it('counts down the tries, then says how long the lock lasts', () => {
    expect(wrongPinMessage(1)).toBe('Wrong PIN. 4 tries left.');
    expect(wrongPinMessage(3)).toBe('Wrong PIN. 2 tries left.');
    expect(wrongPinMessage(4)).toBe('Wrong PIN. 1 try left.');
    expect(wrongPinMessage(5)).toBe('Too many tries. Try again in 15 minutes.');
    expect(lockedMessage(1)).toBe('Too many tries. Try again in 1 minute.');
    expect(lockedMessage(7)).toBe('Too many tries. Try again in 7 minutes.');
  });

  it('tells a refused password from Supabase not answering', () => {
    expect(isWrongCredentials({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(true);
    expect(isWrongCredentials({ code: 'invalid_grant' })).toBe(true);
    expect(isWrongCredentials({ status: 0, message: 'fetch failed' })).toBe(false);
    expect(isWrongCredentials({ status: 503, message: 'upstream' })).toBe(false);
    expect(isWrongCredentials(null)).toBe(false);
  });
});

describe('the lockout', () => {
  it('counts each attempt and locks the name at the fifth wrong PIN, for 15 minutes', () => {
    expect(MAX_TRIES).toBe(5);
    expect(LOCK_MINUTES).toBe(15);
    expect(startAttempt(null, T0)).toEqual({ kind: 'try', failed: 1, lockedUntil: null });
    expect(startAttempt({ failed: 3, locked_until: null, updated_at: '' }, T0)).toEqual({ kind: 'try', failed: 4, lockedUntil: null });
    expect(startAttempt({ failed: 4, locked_until: null, updated_at: '' }, T0)).toEqual({ kind: 'try', failed: 5, lockedUntil: '2026-11-20T15:15:00.000Z' });
    // A count past the limit with no lock (not written by the app) still locks, never goes higher.
    expect(startAttempt({ failed: 9, locked_until: null, updated_at: '' }, T0)).toMatchObject({ failed: 5 });
  });

  it('refuses while locked, saying the minutes left, and starts again once the lock has run out', () => {
    const row = { failed: 5, locked_until: '2026-11-20T15:15:00.000Z', updated_at: '' };
    expect(startAttempt(row, T0)).toEqual({ kind: 'locked', minutes: 15 });
    expect(startAttempt(row, new Date('2026-11-20T15:10:30.000Z'))).toEqual({ kind: 'locked', minutes: 5 });
    expect(startAttempt(row, new Date('2026-11-20T15:14:59.000Z'))).toEqual({ kind: 'locked', minutes: 1 });
    expect(startAttempt(row, new Date('2026-11-20T15:15:00.000Z'))).toEqual({ kind: 'try', failed: 1, lockedUntil: null });
    expect(minutesLeft(new Date(T0.getTime() + 1), T0)).toBe(1);
    expect(minutesLeft(T0, T0)).toBe(1);
  });
});

describe('pin_attempts, written with the service role', () => {
  it('counts an attempt before the PIN is checked: a new row, then one more each time', async () => {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew');
    const first = await reserveAttempt(db.client, CREW, at(0));
    expect(first).toMatchObject({ kind: 'try', failed: 1, prev: null });
    expect(db.attempts.get(CREW)).toMatchObject({ failed: 1, locked_until: null, updated_at: T0.toISOString() });
    const second = await reserveAttempt(db.client, CREW, at(1));
    expect(second).toMatchObject({ kind: 'try', failed: 2, prev: { failed: 1 } });
    expect(db.attempts.get(CREW)!.failed).toBe(2);
  });

  it('stores nothing for someone who is not there', async () => {
    const db = fakeDb();
    expect(await reserveAttempt(db.client, NOBODY, at(0))).toEqual({ kind: 'unknown' });
    expect(db.attempts.size).toBe(0);
  });

  it('reads again when another attempt wrote first (insert or update), so none count from the same number', async () => {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew');
    db.race(() => db.attempts.set(CREW, { profile_id: CREW, failed: 1, locked_until: null, updated_at: 'x' }));
    expect(await reserveAttempt(db.client, CREW, at(0))).toMatchObject({ kind: 'try', failed: 2 });
    db.race(() => Object.assign(db.attempts.get(CREW)!, { failed: 3, updated_at: 'y' }));
    expect(await reserveAttempt(db.client, CREW, at(0))).toMatchObject({ kind: 'try', failed: 4 });
    expect(db.calls.filter((c) => c === 'pin_attempts.select').length).toBe(4);
  });

  it('gives up after a few rounds of losing, and says when the database does not answer', async () => {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew');
    db.attempts.set(CREW, { profile_id: CREW, failed: 1, locked_until: null, updated_at: 'a' });
    let n = 0;
    const always = () => {
      Object.assign(db.attempts.get(CREW)!, { updated_at: `b${n++}` });
      db.race(always);
    };
    db.race(always);
    expect(await reserveAttempt(db.client, CREW, at(0))).toMatchObject({ kind: 'error' });
    const down = fakeDb();
    down.fail.read = { message: 'upstream' };
    expect(await reserveAttempt(down.client, CREW, at(0))).toEqual({ kind: 'error', message: 'upstream' });
    const noInsert = fakeDb();
    noInsert.addPerson(CREW, 'crew', 'Nell Crew');
    noInsert.fail.insert = { message: 'insert failed' };
    expect(await reserveAttempt(noInsert.client, CREW, at(0))).toEqual({ kind: 'error', message: 'insert failed' });
    noInsert.attempts.set(CREW, { profile_id: CREW, failed: 1, locked_until: null, updated_at: 'a' });
    noInsert.fail.update = { message: 'update failed' };
    expect(await reserveAttempt(noInsert.client, CREW, at(0))).toEqual({ kind: 'error', message: 'update failed' });
  });

  it('takes back an attempt that could not be checked, unless another changed the row since', async () => {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew');
    const r1 = await reserveAttempt(db.client, CREW, at(0));
    await releaseAttempt(db.client, CREW, r1 as Extract<typeof r1, { kind: 'try' }>);
    expect(db.attempts.has(CREW)).toBe(false);
    await reserveAttempt(db.client, CREW, at(1));
    const r2 = await reserveAttempt(db.client, CREW, at(2));
    await releaseAttempt(db.client, CREW, r2 as Extract<typeof r2, { kind: 'try' }>);
    expect(db.attempts.get(CREW)).toMatchObject({ failed: 1, updated_at: at(1)().toISOString() });
    const r3 = await reserveAttempt(db.client, CREW, at(3));
    await reserveAttempt(db.client, CREW, at(4)); // another attempt after it
    await releaseAttempt(db.client, CREW, r3 as Extract<typeof r3, { kind: 'try' }>);
    expect(db.attempts.get(CREW)!.failed).toBe(3);
  });

  it('clears the count and the lock', async () => {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew');
    db.attempts.set(CREW, { profile_id: CREW, failed: 5, locked_until: '2026-11-20T15:15:00.000Z', updated_at: 'a' });
    expect(await clearAttempts(db.client, CREW)).toBeNull();
    expect(db.attempts.has(CREW)).toBe(false);
    db.fail.delete = { message: 'no' };
    expect(await clearAttempts(db.client, CREW)).toBe('no');
  });
});

describe('checking a PIN', () => {
  function setup() {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew');
    db.addPerson(OFFICE, 'office', 'Oscar Office', { pin: '2580' });
    db.addPerson(MAIL, 'estimator', 'Email Person', { pinSignIn: false, email: 'email.person@example.com' });
    db.addPerson(OFF, 'crew', 'Gone Crew', { active: false });
    let minutes = 0;
    const deps = { admin: db.client, secret: SECRET, signIn: db.signIn, now: () => at(minutes)() };
    return { db, deps, wait: (m: number) => (minutes += m) };
  }

  it('lets the right PIN in, with the role, and clears earlier wrong PINs', async () => {
    const { db, deps } = setup();
    expect(await checkPin(deps, CREW, '9999')).toEqual({ ok: false, kind: 'wrong', message: 'Wrong PIN. 4 tries left.' });
    expect(await checkPin(deps, CREW, '1234')).toEqual({ ok: true, role: 'crew', email: pinLoginEmail(CREW) });
    expect(db.signIn).toHaveBeenLastCalledWith(pinLoginEmail(CREW), derivedPassword(CREW, '1234', SECRET));
    expect(db.attempts.has(CREW)).toBe(false);
    expect(await checkPin(deps, CREW, '0000')).toMatchObject({ message: 'Wrong PIN. 4 tries left.' });
    expect(await checkPin(deps, OFFICE, '2580')).toMatchObject({ ok: true, role: 'office' });
    expect(await checkPin(deps, CREW.toUpperCase(), '1234')).toMatchObject({ ok: true });
  });

  it('locks the name after 5 wrong PINs, refuses the right PIN while locked, and opens after 15 minutes', async () => {
    const { db, deps, wait } = setup();
    for (let i = 0; i < 5; i++) await checkPin(deps, OFFICE, '1111');
    expect(await checkPin(deps, OFFICE, '2580')).toEqual({ ok: false, kind: 'locked', message: 'Too many tries. Try again in 15 minutes.' });
    expect(db.signIn).toHaveBeenCalledTimes(5);
    wait(9);
    expect(await checkPin(deps, OFFICE, '2580')).toMatchObject({ kind: 'locked', message: 'Too many tries. Try again in 6 minutes.' });
    expect(await checkPin(deps, CREW, '1234')).toMatchObject({ ok: true }); // another name is not locked
    wait(6);
    expect(await checkPin(deps, OFFICE, '2580')).toMatchObject({ ok: true, role: 'office' });
    expect(db.attempts.has(OFFICE)).toBe(false);
  });

  it('says how many tries are left, each time', async () => {
    const { deps } = setup();
    const messages = [];
    for (let i = 0; i < 6; i++) messages.push((await checkPin(deps, CREW, '4321')) as { kind: string; message: string });
    expect(messages.map((m) => m.message)).toEqual([
      'Wrong PIN. 4 tries left.',
      'Wrong PIN. 3 tries left.',
      'Wrong PIN. 2 tries left.',
      'Wrong PIN. 1 try left.',
      'Too many tries. Try again in 15 minutes.',
      'Too many tries. Try again in 15 minutes.',
    ]);
    expect(messages.map((m) => m.kind)).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'locked', 'locked']);
  });

  it('gives PINs sent side by side no more than 5 tries between them', async () => {
    const { db, deps } = setup();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => checkPin(deps, CREW, String(1000 + i * 7).padStart(4, '0'))));
    expect(db.signIn.mock.calls.length).toBeLessThanOrEqual(MAX_TRIES);
    expect(results.filter((r) => !r.ok && r.kind === 'locked').length).toBeGreaterThanOrEqual(12 - MAX_TRIES);
    expect(db.attempts.get(CREW)).toMatchObject({ failed: 5 });
  });

  it('never says whether a name exists: inactive, email-only and unknown people read as a wrong PIN', async () => {
    const { db, deps } = setup();
    expect(await checkPin(deps, OFF, '1234')).toEqual({ ok: false, kind: 'wrong', message: 'Wrong PIN. 4 tries left.' });
    expect(await checkPin(deps, OFF, '1234')).toMatchObject({ message: 'Wrong PIN. 3 tries left.' });
    expect(await checkPin(deps, MAIL, '1234')).toMatchObject({ message: 'Wrong PIN. 4 tries left.' });
    expect(await checkPin(deps, NOBODY, '1234')).toMatchObject({ kind: 'wrong', message: 'Wrong PIN. 4 tries left.' });
    expect(await checkPin(deps, 'not-an-id', '1234')).toMatchObject({ kind: 'wrong', message: 'Wrong PIN. 4 tries left.' });
    expect(db.signIn).not.toHaveBeenCalled();
    db.users.delete(CREW); // a profile whose login is gone
    expect(await checkPin(deps, CREW, '1234')).toMatchObject({ kind: 'wrong' });
    db.users.set(CREW, { id: CREW, email: '', password: '', user_metadata: {} });
    expect(await checkPin(deps, CREW, '1234')).toMatchObject({ kind: 'wrong', message: 'Wrong PIN. 3 tries left.' });
  });

  it('asks for four digits without counting anything', async () => {
    const { db, deps } = setup();
    expect(await checkPin(deps, CREW, '12')).toEqual({ ok: false, kind: 'invalid', message: 'Enter the 4 digits of your PIN.' });
    expect(await checkPin(deps, CREW, 1234)).toMatchObject({ kind: 'invalid' });
    expect(db.attempts.size).toBe(0);
  });

  it('when Koala does not answer, says so and gives the try back', async () => {
    for (const breakIt of [
      (db: ReturnType<typeof fakeDb>) => (db.fail.profiles = { message: 'down' }),
      (db: ReturnType<typeof fakeDb>) => (db.fail.getUser = { message: 'down', status: 503 }),
      (db: ReturnType<typeof fakeDb>) => db.signIn.mockResolvedValueOnce({ error: { status: 0, message: 'fetch failed' } }),
    ]) {
      const { db, deps } = setup();
      breakIt(db);
      expect(await checkPin(deps, CREW, '1234')).toEqual({ ok: false, kind: 'unreachable', message: "Can't reach Koala right now. Try again in a minute." });
      expect(db.attempts.has(CREW)).toBe(false);
    }
    const { db, deps } = setup();
    db.fail.read = { message: 'down' };
    expect(await checkPin(deps, CREW, '1234')).toMatchObject({ kind: 'unreachable' });
  });
});

describe('adding a PIN person and setting their PIN', () => {
  it('creates the login with the id it chose, the made-up address confirmed, and the derived password', async () => {
    const db = fakeDb();
    const made = await createPinLogin(db.client, { fullName: 'Nell Crew', pin: '1234', secret: SECRET }, () => CREW);
    expect(made).toEqual({ ok: true, userId: CREW });
    expect(db.users.get(CREW)).toEqual({ id: CREW, email: pinLoginEmail(CREW), password: derivedPassword(CREW, '1234', SECRET), user_metadata: { full_name: 'Nell Crew' } });
    expect(db.calls).toEqual(['createUser confirm=true']);
  });

  it('derives the password from the id the sign-in service gave, if it gave its own', async () => {
    const db = fakeDb();
    db.ignoreGivenId();
    const made = await createPinLogin(db.client, { fullName: 'Nell Crew', pin: '1234', secret: SECRET }, () => CREW);
    const given = '0b000000-0000-4000-8000-000000000099';
    expect(made).toEqual({ ok: true, userId: given });
    expect(db.users.get(given)!.password).toBe(derivedPassword(given, '1234', SECRET));
    db.fail.updateUser = { message: 'cannot update' };
    expect(await createPinLogin(db.client, { fullName: 'Nell Crew', pin: '1234', secret: SECRET }, () => CREW)).toEqual({ ok: false, error: 'cannot update' });
    expect(db.calls.at(-1)).toBe(`deleteUser ${given}`);
  });

  it('says why a login could not be made', async () => {
    const db = fakeDb();
    db.fail.createUser = { message: 'Database error creating new user' };
    expect(await createPinLogin(db.client, { fullName: 'X', pin: '1234', secret: SECRET })).toEqual({ ok: false, error: 'Database error creating new user' });
  });

  it('sets a new PIN and clears the lock', async () => {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew', { pin: '5555' });
    db.attempts.set(CREW, { profile_id: CREW, failed: 5, locked_until: '2026-11-20T15:15:00.000Z', updated_at: 'a' });
    expect(await setPin(db.client, CREW, '1234', SECRET)).toBeNull();
    expect(db.users.get(CREW)!.password).toBe(derivedPassword(CREW, '1234', SECRET));
    expect(db.attempts.has(CREW)).toBe(false);
    db.fail.updateUser = { message: 'nope' };
    expect(await setPin(db.client, CREW, '1234', SECRET)).toBe('nope');
  });
});

describe('the names on the sign-in page', () => {
  it('lists owner, office, estimator, crew, then by name, as "First · Role"', () => {
    const list = pinSignInList([
      { id: '4', full_name: 'Nell Crew', role: 'crew' },
      { id: '1', full_name: 'Richard  Roe', role: 'owner' },
      { id: '3', full_name: 'Ann Field', role: 'estimator' },
      { id: '2', full_name: 'Oscar Office', role: 'office' },
      { id: '5', full_name: 'Abe Crew', role: 'crew' },
    ]);
    expect(list.map((n) => n.label)).toEqual(['Richard · Owner', 'Oscar · Office', 'Ann · Estimator', 'Abe · Crew', 'Nell · Crew']);
    expect(list[0]).toEqual({ id: '1', name: 'Richard', role: 'owner', label: 'Richard · Owner' });
  });

  it('uses the full name when two people share a first name', () => {
    const list = pinSignInList([
      { id: '1', full_name: 'Sam Lee', role: 'crew' },
      { id: '2', full_name: 'sam Diaz', role: 'crew' },
      { id: '3', full_name: 'Cher', role: 'crew' },
    ]);
    expect(list.map((n) => n.label)).toEqual(['Cher · Crew', 'sam Diaz · Crew', 'Sam Lee · Crew']);
  });

  it('reads only active people listed for PIN sign-in, and nothing when Koala does not answer', async () => {
    const db = fakeDb();
    db.addPerson(CREW, 'crew', 'Nell Crew');
    db.addPerson(OFFICE, 'office', 'Oscar Office');
    db.addPerson(MAIL, 'estimator', 'Email Person', { pinSignIn: false });
    db.addPerson(OFF, 'crew', 'Gone Crew', { active: false });
    expect((await loadPinNames(db.client))!.map((n) => n.label)).toEqual(['Oscar · Office', 'Nell · Crew']);
    db.profiles.set('x', { id: 'x', full_name: 'Bad Role', role: 'boss', active: true, pin_sign_in: true });
    expect(await loadPinNames(db.client)).toBeNull();
    db.fail.profiles = { message: 'down' };
    expect(await loadPinNames(db.client)).toBeNull();
  });
});

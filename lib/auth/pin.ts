import 'server-only';
// Sign in with your name and a 4-digit PIN, for staff with no work email (the owner's request).
//
// How it works:
//  - A PIN person's Supabase login is a made-up address, pin.<id>@example.com (example.com is
//    reserved; nothing is ever mailed to it: the user is created with the email confirmed), and
//    a password derived from the PIN: base64url(HMAC-SHA256(PIN_SECRET, id + ':' + pin)). Never
//    the PIN itself: Supabase needs 6+ characters, and without PIN_SECRET nobody can try PINs
//    against Supabase directly, so the lockout below cannot be gone around.
//  - profiles.pin_sign_in lists the person on the sign-in page (first name and role only).
//  - pin_attempts (service role only) counts wrong PINs in a row: 5 lock the name for 15
//    minutes, and the right PIN starts the count again. An attempt is counted BEFORE the PIN is
//    checked (and taken back when it proves right), with a compare-and-set write, so PINs sent
//    side by side cannot get more than 5 tries between them.
//  - Known phones (review SEC-PIN-3): every id is on the sign-in page, so a stranger's script
//    could send 5 wrong PINs for each name every 15 minutes and keep the whole crew out all day.
//    So a phone that has signed in as a person is remembered in a signed, httpOnly cookie, and on
//    that phone the person's PINs are counted on their own (pin_device_attempts: 5 wrong lock
//    that phone for that person only); a lock on the name does not stop them there. Every other
//    phone, and any script, shares the name's count as before, so guessing stays at 5 tries per
//    15 minutes, and only the right PIN makes a phone known.
//  - What the sign-in page answers never says whether a name exists: a person who is not listed
//    (inactive, email only, or no one at all) gets the same "Wrong PIN" as a wrong PIN.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ROLE_LABELS, ROLES, type TeamRole } from '@/lib/admin/team';
import { isPin, PIN_LENGTH } from './pinShared';

export { DEFAULT_PIN, isPin, PIN_LENGTH } from './pinShared';

/** Wrong PINs in a row that lock a name. */
export const MAX_TRIES = 5;
/** How long a locked name stays locked. */
export const LOCK_MINUTES = 15;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

// ---------------------------------------------------------------------------------------------
// The login behind a PIN
// ---------------------------------------------------------------------------------------------

/** The Supabase password of a PIN person: never the PIN itself. */
export function derivedPassword(userId: string, pin: string, secret: string): string {
  if (!secret) throw new Error('PIN_SECRET is not set');
  return createHmac('sha256', secret).update(`${userId}:${pin}`).digest('base64url');
}

/** The made-up login address of a PIN person (never mailed: created with the email confirmed). */
export function pinLoginEmail(userId: string): string {
  return `pin.${userId.toLowerCase()}@example.com`;
}

/** True for a PIN person's made-up login address, which the app never shows. */
export function isPinLoginEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && /^pin\.[0-9a-f-]{36}@example\.com$/i.test(email);
}

/**
 * The email the app may show and put on a quote for a signed-in person: theirs, or none for a PIN
 * person (their login address is made up and nobody reads it).
 */
export function shownEmail(authEmail: string | null | undefined): string | null {
  return !authEmail || isPinLoginEmail(authEmail) ? null : authEmail;
}

// ---------------------------------------------------------------------------------------------
// Known phones
// ---------------------------------------------------------------------------------------------

/** The cookie that remembers who has signed in with a PIN on this phone. */
export const DEVICE_COOKIE = 'koala_pin_device';
/** How long a phone stays known without signing in again (the longest a browser keeps a cookie). */
export const DEVICE_COOKIE_DAYS = 400;
/** People one phone remembers (a shared crew tablet): the latest to sign in on it. */
export const MAX_KNOWN_PEOPLE = 8;

// The cookie is "<phone id>.<seal>.<seal>...": a random id for the phone, then a seal per person
// who signed in on it, HMAC(PIN_SECRET, 'device:' + person + ':' + phone id) cut to 16 bytes. It
// names nobody, and nobody can make a seal without PIN_SECRET.
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const MAX_COOKIE = 512;

function deviceSeal(profileId: string, deviceId: string, secret: string): string {
  return createHmac('sha256', secret).update(`device:${profileId.toLowerCase()}:${deviceId}`).digest().subarray(0, 16).toString('base64url');
}

function readDeviceCookie(value: unknown): { deviceId: string; seals: string[] } | null {
  if (typeof value !== 'string' || value.length > MAX_COOKIE) return null;
  const [deviceId, ...seals] = value.split('.');
  if (!deviceId || !TOKEN.test(deviceId)) return null;
  return { deviceId, seals: seals.filter((t) => TOKEN.test(t)).slice(0, MAX_KNOWN_PEOPLE) };
}

/** The phone's id when its cookie shows `profileId` has signed in on it; null for anyone else's. */
export function knownDevice(cookie: unknown, profileId: string, secret: string): string | null {
  const c = secret ? readDeviceCookie(cookie) : null;
  if (!c) return null;
  const want = Buffer.from(deviceSeal(profileId, c.deviceId, secret));
  return c.seals.some((t) => timingSafeEqual(Buffer.from(t), want)) ? c.deviceId : null;
}

/**
 * The cookie after `profileId` signed in on this phone: the phone keeps its id (a new one if it
 * had no cookie of ours), and the person goes first, once, ahead of up to 7 others.
 */
export function rememberDevice(cookie: unknown, profileId: string, secret: string, newId: () => string = () => randomBytes(16).toString('base64url')): string {
  const c = readDeviceCookie(cookie);
  const deviceId = c?.deviceId ?? newId();
  const seal = deviceSeal(profileId, deviceId, secret);
  return [deviceId, seal, ...(c?.seals ?? []).filter((t) => t !== seal)].slice(0, 1 + MAX_KNOWN_PEOPLE).join('.');
}

/** What pin_device_attempts holds for a phone: a hash of its id, never the id from the cookie. */
export function deviceKey(deviceId: string): string {
  return createHash('sha256').update(`pin-device:${deviceId}`).digest('base64url');
}

/** How the known-phone cookie is set: httpOnly, for every page (sign-in and "Change my PIN"). */
export function deviceCookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: DEVICE_COOKIE_DAYS * 24 * 60 * 60 };
}

// ---------------------------------------------------------------------------------------------
// What the person reads
// ---------------------------------------------------------------------------------------------

export const PIN_OFF_MESSAGE = 'Signing in with your name and PIN is turned off on this server. Sign in with your email code, or ask the owner.';
export const ENTER_PIN_MESSAGE = `Enter the ${PIN_LENGTH} digits of your PIN.`;
export const PIN_UNREACHABLE_MESSAGE = "Can't reach Koala right now. Try again in a minute.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Too many tries. Try again in 15 minutes." */
export function lockedMessage(minutes: number): string {
  return `Too many tries. Try again in ${plural(minutes, 'minute', 'minutes')}.`;
}

/** After the `failed`-th wrong PIN in a row: "Wrong PIN. 4 tries left.", or locked at the last. */
export function wrongPinMessage(failed: number): string {
  const left = MAX_TRIES - failed;
  return left > 0 ? `Wrong PIN. ${plural(left, 'try', 'tries')} left.` : lockedMessage(LOCK_MINUTES);
}

// ---------------------------------------------------------------------------------------------
// The lockout (pure)
// ---------------------------------------------------------------------------------------------

/** A person's row in pin_attempts. */
export interface AttemptRow {
  failed: number;
  locked_until: string | null;
  updated_at: string;
}

export type AttemptStart =
  /** Locked: the PIN is not even checked. */
  | { kind: 'locked'; minutes: number }
  /** Not locked: the row to write before checking, counting this attempt as wrong. */
  | { kind: 'try'; failed: number; lockedUntil: string | null };

/** Whole minutes until `until`, at least 1. */
export function minutesLeft(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
}

/**
 * What an attempt at `now` may do, given the person's row (null: no wrong PINs yet). A lock that
 * has run out starts the count again. The attempt that makes it 5 wrong in a row locks the name
 * at once (the right PIN on that attempt still gets in, and clears it).
 */
export function startAttempt(row: AttemptRow | null, now: Date): AttemptStart {
  const lockedUntil = row?.locked_until ? new Date(row.locked_until) : null;
  if (lockedUntil && lockedUntil > now) return { kind: 'locked', minutes: minutesLeft(lockedUntil, now) };
  const before = row && !lockedUntil ? Math.min(Math.max(row.failed, 0), MAX_TRIES - 1) : 0;
  const failed = before + 1;
  return { kind: 'try', failed, lockedUntil: failed >= MAX_TRIES ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null };
}

// ---------------------------------------------------------------------------------------------
// pin_attempts and pin_device_attempts (service role)
// ---------------------------------------------------------------------------------------------

export type Reservation =
  | { kind: 'locked'; minutes: number }
  /** No such person: nothing stored. */
  | { kind: 'unknown' }
  /** `device`: the known phone's key the attempt was counted on, or null for the name's count. */
  | { kind: 'try'; failed: number; prev: AttemptRow | null; wrote: AttemptRow; device: string | null }
  | { kind: 'error'; message: string };

/**
 * One count: the name's (pin_attempts: every phone the person has not signed in on, and any
 * script), or one known phone's (pin_device_attempts, by person and phone key). `key` is its
 * primary key, to match on.
 */
function attemptCount(admin: SupabaseClient, profileId: string, device: string | null) {
  return {
    from: () => admin.from(device ? 'pin_device_attempts' : 'pin_attempts'),
    key: device ? { profile_id: profileId, device } : { profile_id: profileId },
  };
}

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
// Each round one attempt of those side by side wins; after MAX_TRIES wins the name is locked and
// every other attempt reads that. Rounds beyond that only happen under a flood.
const ROUNDS = MAX_TRIES * 2;

/**
 * Counts an attempt as wrong before its PIN is checked, unless that count is locked: the name's,
 * or with `device` (a known phone's key) that phone's. The write only lands on the row as it was
 * read (failed, locked_until and updated_at all equal), so two attempts side by side never both
 * count from the same number: the one that loses reads again.
 */
export async function reserveAttempt(
  admin: SupabaseClient,
  profileId: string,
  now: () => Date = () => new Date(),
  device: string | null = null,
): Promise<Reservation> {
  const count = attemptCount(admin, profileId, device);
  for (let round = 0; round < ROUNDS; round++) {
    const read = await count.from().select('failed, locked_until, updated_at').match(count.key).maybeSingle();
    if (read.error) return { kind: 'error', message: read.error.message };
    const prev = (read.data as AttemptRow | null) ?? null;
    const t = now();
    const start = startAttempt(prev, t);
    if (start.kind === 'locked') return start;
    const wrote: AttemptRow = { failed: start.failed, locked_until: start.lockedUntil, updated_at: t.toISOString() };
    if (!prev) {
      const ins = await count.from().insert({ ...count.key, ...wrote });
      if (!ins.error) return { kind: 'try', failed: start.failed, prev, wrote, device };
      if (ins.error.code === FOREIGN_KEY_VIOLATION) return { kind: 'unknown' };
      if (ins.error.code !== UNIQUE_VIOLATION) return { kind: 'error', message: ins.error.message };
      continue; // another attempt wrote first: read again
    }
    const up = await sameRow(count.from().update(wrote).match(count.key), prev).select('profile_id');
    if (up.error) return { kind: 'error', message: up.error.message };
    if ((up.data ?? []).length === 1) return { kind: 'try', failed: start.failed, prev, wrote, device };
  }
  return { kind: 'error', message: 'Too many sign-ins for this name at once.' };
}

/** Narrows an update or delete to the row exactly as it was. */
function sameRow<Q extends { eq(column: string, value: unknown): Q; is(column: string, value: null): Q }>(q: Q, row: AttemptRow): Q {
  const narrowed = q.eq('failed', row.failed).eq('updated_at', row.updated_at);
  return row.locked_until === null ? narrowed.is('locked_until', null) : narrowed.eq('locked_until', row.locked_until);
}

/**
 * Takes back an attempt whose PIN could not be checked (Koala did not answer): the row goes back
 * to how it was, unless another attempt has changed it since. Best effort.
 */
export async function releaseAttempt(admin: SupabaseClient, profileId: string, r: Extract<Reservation, { kind: 'try' }>): Promise<void> {
  const count = attemptCount(admin, profileId, r.device);
  try {
    if (!r.prev) await sameRow(count.from().delete().match(count.key), r.wrote);
    else await sameRow(count.from().update(r.prev).match(count.key), r.wrote);
  } catch {
    // The count stays one higher: the person sees one try fewer, nothing worse.
  }
}

/** The right PIN: that count (the name's, or the known phone's) starts again. */
async function clearCount(admin: SupabaseClient, profileId: string, device: string | null): Promise<void> {
  const count = attemptCount(admin, profileId, device);
  await count.from().delete().match(count.key);
}

/** The owner's Reset PIN, or a changed PIN: no wrong PINs and no lock, for the name or any phone. */
export async function clearAttempts(admin: SupabaseClient, profileId: string): Promise<string | null> {
  const [name, phones] = await Promise.all([
    admin.from('pin_attempts').delete().eq('profile_id', profileId),
    admin.from('pin_device_attempts').delete().eq('profile_id', profileId),
  ]);
  return name.error?.message ?? phones.error?.message ?? null;
}

// ---------------------------------------------------------------------------------------------
// Checking a PIN (sign-in, and the current PIN on "Change my PIN")
// ---------------------------------------------------------------------------------------------

/** What Supabase answered a password sign-in: only whether and how it failed matters here. */
export interface PasswordSignIn {
  error: { status?: number; code?: string; message?: string } | null;
}

export type PinCheck =
  /** `device`: the known-phone cookie to set on the answer (this phone now knows the person). */
  | { ok: true; role: TeamRole; email: string; device: string }
  | { ok: false; kind: 'invalid' | 'wrong' | 'locked' | 'unreachable'; message: string };

/** A refused email and password (400 from Supabase's token endpoint), not a failure to answer. */
export function isWrongCredentials(error: PasswordSignIn['error']): boolean {
  if (!error) return false;
  return error.status === 400 || error.code === 'invalid_credentials' || error.code === 'invalid_grant';
}

const profileRow = z.object({ role: z.enum(ROLES), active: z.boolean(), pin_sign_in: z.boolean() });

/**
 * Checks `pin` for the person `profileId`: the lockout first, then the person (active and listed
 * for PIN sign-in), their login address (auth.admin.getUserById), then `signIn` with the derived
 * password. `signIn` decides where a session goes: the sign-in route's cookie client, or a
 * throwaway client for "Change my PIN". Every way of failing for a person reads like a wrong PIN.
 * `device` is the known-phone cookie the request came with: when it shows the person has signed
 * in on this phone, the attempt is counted on the phone's own count, not the name's.
 */
export async function checkPin(
  deps: {
    admin: SupabaseClient;
    secret: string;
    signIn: (email: string, password: string) => Promise<PasswordSignIn>;
    now?: () => Date;
    device?: string | null;
  },
  profileId: unknown,
  pin: unknown,
): Promise<PinCheck> {
  if (!isPin(pin)) return { ok: false, kind: 'invalid', message: ENTER_PIN_MESSAGE };
  const wrong = (failed: number): PinCheck => ({ ok: false, kind: failed >= MAX_TRIES ? 'locked' : 'wrong', message: wrongPinMessage(failed) });
  if (!isUuid(profileId)) return wrong(1);
  return checkPinFor(deps, profileId.toLowerCase(), pin, wrong);
}

async function checkPinFor(
  deps: Parameters<typeof checkPin>[0],
  profileId: string,
  pin: string,
  wrong: (failed: number) => PinCheck,
): Promise<PinCheck> {
  const { admin } = deps;
  const unreachable: PinCheck = { ok: false, kind: 'unreachable', message: PIN_UNREACHABLE_MESSAGE };

  const phone = knownDevice(deps.device, profileId, deps.secret);
  const device = phone ? deviceKey(phone) : null;
  const r = await reserveAttempt(admin, profileId, deps.now, device);
  if (r.kind === 'locked') return { ok: false, kind: 'locked', message: lockedMessage(r.minutes) };
  if (r.kind === 'unknown') return wrong(1);
  if (r.kind === 'error') return unreachable;
  const giveBack = async () => {
    await releaseAttempt(admin, profileId, r);
    return unreachable;
  };

  const p = await admin.from('profiles').select('role, active, pin_sign_in').eq('id', profileId).maybeSingle();
  if (p.error) return giveBack();
  const person = profileRow.safeParse(p.data);
  if (!person.success || !person.data.active || !person.data.pin_sign_in) return wrong(r.failed);

  const u = await admin.auth.admin.getUserById(profileId);
  if (u.error) return u.error.status === 404 ? wrong(r.failed) : giveBack();
  const email = u.data.user?.email;
  if (!email) return wrong(r.failed);

  const s = await deps.signIn(email, derivedPassword(profileId, pin, deps.secret));
  if (s.error) return isWrongCredentials(s.error) ? wrong(r.failed) : giveBack();

  // Only the count this attempt was on: the person's right PIN on their own phone gives a
  // stranger who locked the name no fresh tries.
  await clearCount(admin, profileId, device);
  return { ok: true, role: person.data.role, email, device: rememberDevice(deps.device, profileId, deps.secret) };
}

// ---------------------------------------------------------------------------------------------
// Adding a PIN person and setting a PIN (owner, team page; the person, "Change my PIN")
// ---------------------------------------------------------------------------------------------

/**
 * Creates the login of a new PIN person: the id is chosen here so the password can be derived
 * from it in the same call. A sign-in service that gives its own id instead gets the password
 * derived from that id right after (and the login is removed if that fails).
 */
export async function createPinLogin(
  admin: SupabaseClient,
  input: { fullName: string; pin: string; secret: string },
  newId: () => string = randomUUID,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const id = newId();
  const made = await admin.auth.admin.createUser({
    id,
    email: pinLoginEmail(id),
    password: derivedPassword(id, input.pin, input.secret),
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
  });
  if (made.error || !made.data.user) return { ok: false, error: made.error?.message ?? 'no user returned' };
  const userId = made.data.user.id;
  if (userId !== id) {
    const fix = await admin.auth.admin.updateUserById(userId, { password: derivedPassword(userId, input.pin, input.secret) });
    if (fix.error) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      return { ok: false, error: fix.error.message };
    }
  }
  return { ok: true, userId };
}

/** Gives a PIN person a new PIN and clears their wrong PINs and lock. Null, or what went wrong. */
export async function setPin(admin: SupabaseClient, userId: string, pin: string, secret: string): Promise<string | null> {
  const up = await admin.auth.admin.updateUserById(userId, { password: derivedPassword(userId, pin, secret) });
  if (up.error) return up.error.message;
  return clearAttempts(admin, userId);
}

// ---------------------------------------------------------------------------------------------
// The names on the sign-in page
// ---------------------------------------------------------------------------------------------

export interface PinName {
  id: string;
  /** The first name, or the full name when two listed people share a first name. */
  name: string;
  role: TeamRole;
  /** "Richard · Owner" */
  label: string;
}

const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? '';

/** The listed people as the sign-in page shows them: owner, office, estimator, crew, then name. */
export function pinSignInList(rows: ReadonlyArray<{ id: string; full_name: string; role: TeamRole }>): PinName[] {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = firstName(r.full_name).toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return rows
    .map((r) => {
      const first = firstName(r.full_name);
      const name = first && seen.get(first.toLowerCase()) === 1 ? first : r.full_name.trim();
      return { id: r.id, name, role: r.role, label: `${name} · ${ROLE_LABELS[r.role]}` };
    })
    .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const nameRows = z.array(z.object({ id: z.string(), full_name: z.string(), role: z.enum(ROLES) }));

/** The active people listed for PIN sign-in, read with the service role; null if Koala did not answer. */
export async function loadPinNames(admin: SupabaseClient): Promise<PinName[] | null> {
  const res = await admin.from('profiles').select('id, full_name, role').eq('active', true).eq('pin_sign_in', true);
  if (res.error) return null;
  const rows = nameRows.safeParse(res.data ?? []);
  return rows.success ? pinSignInList(rows.data) : null;
}

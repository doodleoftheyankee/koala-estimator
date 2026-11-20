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
//  - What the sign-in page answers never says whether a name exists: a person who is not listed
//    (inactive, email only, or no one at all) gets the same "Wrong PIN" as a wrong PIN.
import { createHmac, randomUUID } from 'node:crypto';
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
// pin_attempts (service role)
// ---------------------------------------------------------------------------------------------

export type Reservation =
  | { kind: 'locked'; minutes: number }
  /** No such person: nothing stored. */
  | { kind: 'unknown' }
  | { kind: 'try'; failed: number; prev: AttemptRow | null; wrote: AttemptRow }
  | { kind: 'error'; message: string };

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
// Each round one attempt of those side by side wins; after MAX_TRIES wins the name is locked and
// every other attempt reads that. Rounds beyond that only happen under a flood.
const ROUNDS = MAX_TRIES * 2;

/**
 * Counts an attempt as wrong before its PIN is checked, unless the name is locked. The write only
 * lands on the row as it was read (failed, locked_until and updated_at all equal), so two attempts
 * side by side never both count from the same number: the one that loses reads again.
 */
export async function reserveAttempt(admin: SupabaseClient, profileId: string, now: () => Date = () => new Date()): Promise<Reservation> {
  for (let round = 0; round < ROUNDS; round++) {
    const read = await admin.from('pin_attempts').select('failed, locked_until, updated_at').eq('profile_id', profileId).maybeSingle();
    if (read.error) return { kind: 'error', message: read.error.message };
    const prev = (read.data as AttemptRow | null) ?? null;
    const t = now();
    const start = startAttempt(prev, t);
    if (start.kind === 'locked') return start;
    const wrote: AttemptRow = { failed: start.failed, locked_until: start.lockedUntil, updated_at: t.toISOString() };
    if (!prev) {
      const ins = await admin.from('pin_attempts').insert({ profile_id: profileId, ...wrote });
      if (!ins.error) return { kind: 'try', failed: start.failed, prev, wrote };
      if (ins.error.code === FOREIGN_KEY_VIOLATION) return { kind: 'unknown' };
      if (ins.error.code !== UNIQUE_VIOLATION) return { kind: 'error', message: ins.error.message };
      continue; // another attempt wrote first: read again
    }
    const up = await sameRow(admin.from('pin_attempts').update(wrote).eq('profile_id', profileId), prev).select('profile_id');
    if (up.error) return { kind: 'error', message: up.error.message };
    if ((up.data ?? []).length === 1) return { kind: 'try', failed: start.failed, prev, wrote };
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
  try {
    const mine = sameRow(admin.from('pin_attempts').delete().eq('profile_id', profileId), r.wrote);
    if (!r.prev) await mine;
    else await sameRow(admin.from('pin_attempts').update(r.prev).eq('profile_id', profileId), r.wrote);
  } catch {
    // The count stays one higher: the person sees one try fewer, nothing worse.
  }
}

/** The right PIN, or the owner's Reset PIN: no wrong PINs, no lock. */
export async function clearAttempts(admin: SupabaseClient, profileId: string): Promise<string | null> {
  const del = await admin.from('pin_attempts').delete().eq('profile_id', profileId);
  return del.error ? del.error.message : null;
}

// ---------------------------------------------------------------------------------------------
// Checking a PIN (sign-in, and the current PIN on "Change my PIN")
// ---------------------------------------------------------------------------------------------

/** What Supabase answered a password sign-in: only whether and how it failed matters here. */
export interface PasswordSignIn {
  error: { status?: number; code?: string; message?: string } | null;
}

export type PinCheck =
  | { ok: true; role: TeamRole; email: string }
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
 */
export async function checkPin(
  deps: { admin: SupabaseClient; secret: string; signIn: (email: string, password: string) => Promise<PasswordSignIn>; now?: () => Date },
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

  const r = await reserveAttempt(admin, profileId, deps.now);
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

  await clearAttempts(admin, profileId);
  return { ok: true, role: person.data.role, email };
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

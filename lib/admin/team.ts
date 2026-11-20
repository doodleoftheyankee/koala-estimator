// Team management form schemas and helpers (pure).
import { z } from 'zod';
import { isPin, PIN_LENGTH } from '@/lib/auth/pinShared';
import { booleanField, textField, uuidField } from './forms';

export const ROLES = ['owner', 'office', 'estimator', 'crew'] as const;
export type TeamRole = (typeof ROLES)[number];

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Owner',
  office: 'Office',
  estimator: 'Estimator',
  crew: 'Crew',
};

const roleField = z.enum(ROLES, { error: 'Pick a role' });

export const inviteForm = z.object({
  full_name: textField('Full name', 120),
  email: z
    .string({ error: 'Email is required' })
    .trim()
    .toLowerCase()
    .pipe(z.email('Enter a valid email address')),
  role: roleField,
});

const pinField = z
  .string({ error: 'Type a PIN' })
  .trim()
  .refine(isPin, `The PIN must be ${PIN_LENGTH} digits (0 to 9)`);

/** What the owner reads when the server has no PIN_SECRET (see .env.example). */
export const PIN_OFF_FOR_OWNER =
  'Signing in with a PIN is off on this server: it has no PIN_SECRET. Ask your developer to set it (see .env.example). You can still invite people by email.';

/** "Add a person" with no email: they sign in with their name and a PIN. */
export const pinMemberForm = z.object({
  full_name: textField('Full name', 120),
  role: roleField,
  pin: pinField,
});

/** "Reset PIN" on a PIN person's row. */
export const resetPinForm = z.object({
  id: uuidField('Team member'),
  pin: pinField,
});

const sameName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * True when someone already listed on the sign-in page has this name (case and spaces aside): two
 * people with one name look alike there, so the owner adds a last name or an initial.
 */
export function pinNameTaken(listed: readonly string[], fullName: string): boolean {
  const name = sameName(fullName);
  return listed.some((n) => sameName(n) === name);
}

export const memberForm = z.object({
  id: uuidField('Team member'),
  role: roleField,
  active: booleanField,
});

/** True when Supabase Auth refused an invite because the email already has an account. */
export function isEmailTakenError(err: { code?: string | null; message?: string | null; status?: number | null } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'email_exists' || err.code === 'user_already_exists') return true;
  return /already (been )?registered|already exists/i.test(err.message ?? '');
}

/** Owners may not demote or deactivate themselves (they could lock everyone out). */
export function selfEditError(selfId: string, edit: { id: string; role: TeamRole; active: boolean }): string | null {
  if (edit.id !== selfId) return null;
  if (edit.role !== 'owner') return 'You cannot change your own role. Ask another owner to do it.';
  if (!edit.active) return 'You cannot deactivate yourself.';
  return null;
}

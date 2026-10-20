// Team management form schemas and helpers (pure).
import { z } from 'zod';
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

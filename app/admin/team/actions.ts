'use server';
// Owner-only team management. The invite itself needs the service role (auth.admin);
// everything else goes through the owner's own client so RLS and the audit log apply.
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionProfile } from '@/lib/server/auth';
import { serverEnv } from '@/lib/env';
import { errorMessage, failure, formToObject, parseWith, success, type ActionResult } from '@/lib/admin/forms';
import { inviteForm, isEmailTakenError, memberForm, ROLE_LABELS, selfEditError, type TeamRole } from '@/lib/admin/team';

const NOT_OWNER = 'Only the owner can manage the team.';
const PATH = '/admin/team';

export async function inviteMember(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(NOT_OWNER);

  const parsed = parseWith(inviteForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { full_name, email, role } = parsed.data;

  const db = await createClient();
  const existing = await db.from('profiles').select('full_name, role, active').eq('email', email).maybeSingle();
  if (existing.error) return failure(existing.error.message);
  if (existing.data) {
    const e = existing.data as { full_name: string; role: TeamRole; active: boolean };
    return failure(
      `${e.full_name} already uses ${email} (${ROLE_LABELS[e.role] ?? e.role}${e.active ? '' : ', inactive'}). Edit them in the list below${e.active ? '' : ' and switch them back on'}.`,
    );
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return failure(`Invites are not configured on this server: ${errorMessage(e)}`);
  }

  const invite = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${serverEnv.appUrl()}/auth/confirm?next=/`,
    data: { full_name },
  });
  if (invite.error || !invite.data.user) {
    if (isEmailTakenError(invite.error)) {
      return failure(
        `${email} already has a sign-in account but is not on the team list. Remove that user in Supabase (Authentication → Users) and invite again, or ask your developer to link the existing account.`,
      );
    }
    return failure(`The invite could not be sent: ${invite.error?.message ?? 'no user returned'}`);
  }
  const userId = invite.data.user.id;

  const insert = await db.from('profiles').insert({ id: userId, full_name, email, role, active: true });
  if (insert.error) {
    // Do not leave an invited login with no profile behind.
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    return failure(`The invite was cancelled because the team profile could not be saved: ${insert.error.message}`);
  }

  revalidatePath(PATH);
  return success(`Invite sent to ${email}.`);
}

export async function updateMember(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(NOT_OWNER);

  const parsed = parseWith(memberForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const edit = parsed.data;

  const selfError = selfEditError(profile.userId, edit);
  if (selfError) return failure(selfError);

  const db = await createClient();
  const write = await db.from('profiles').update({ role: edit.role, active: edit.active }).eq('id', edit.id).select('id');
  if (write.error) return failure(`Saving failed: ${write.error.message}`);
  if (!write.data?.length) return failure('That team member was not found, or you are not allowed to change them.');

  revalidatePath(PATH);
  return success();
}

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
import { crewFieldName, membershipChanges, parseMembershipForm } from '@/lib/jobs/forms';

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

/**
 * Which crews a person belongs to, and whether they lead it. Crew membership decides which jobs
 * a crew user sees and may enter actuals for (crew_job_view, RLS). Only crews present on the form
 * change.
 */
export async function updateCrewMembership(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(NOT_OWNER);

  const db = await createClient();
  const crews = await db.from('crews').select('id');
  if (crews.error) return failure(`Loading crews failed: ${crews.error.message}`);
  const obj = formToObject(fd);
  const crewIds = (crews.data ?? []).map((c) => String((c as { id: unknown }).id)).filter((id) => crewFieldName(id) in obj);
  const parsed = parseMembershipForm(obj, crewIds);
  if (!parsed.ok) return failure(parsed.error);

  const person = await db.from('profiles').select('id').eq('id', parsed.profileId).maybeSingle();
  if (person.error || !person.data) return failure('That team member was not found.');
  const existing = await db.from('crew_members').select('crew_id, is_lead').eq('profile_id', parsed.profileId);
  if (existing.error) return failure(`Loading crew membership failed: ${existing.error.message}`);
  const { upserts, deletes } = membershipChanges(
    (existing.data ?? []).map((m) => ({ crewId: String((m as { crew_id: unknown }).crew_id), isLead: Boolean((m as { is_lead: unknown }).is_lead) })),
    parsed.memberships,
    crewIds,
  );
  if (!upserts.length && !deletes.length) return success('No changes.');

  if (deletes.length) {
    const del = await db.from('crew_members').delete().eq('profile_id', parsed.profileId).in('crew_id', deletes);
    if (del.error) return failure(`Saving failed: ${del.error.message}`);
  }
  if (upserts.length) {
    const up = await db
      .from('crew_members')
      .upsert(upserts.map((u) => ({ crew_id: u.crewId, profile_id: parsed.profileId, is_lead: u.isLead })), { onConflict: 'crew_id,profile_id' });
    if (up.error) return failure(`Saving failed: ${up.error.message}`);
  }

  revalidatePath(PATH);
  return success('Crews saved.');
}

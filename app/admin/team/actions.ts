'use server';
// Owner-only team management. The invite itself needs the service role (auth.admin);
// everything else goes through the owner's own client so RLS and the audit log apply.
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionProfile } from '@/lib/server/auth';
import { actionRefusal } from '@/lib/server/actionAuth';
import { serverEnv } from '@/lib/env';
import { createPinLogin, setPin } from '@/lib/auth/pin';
import { errorMessage, failure, formToObject, parseWith, success, type ActionResult } from '@/lib/admin/forms';
import { inviteForm, isEmailTakenError, memberForm, PIN_OFF_FOR_OWNER, pinMemberForm, pinNameTaken, resetPinForm, ROLE_LABELS, selfEditError, type TeamRole } from '@/lib/admin/team';
import { crewFieldName, membershipChanges, parseCrewChoices, parseMembershipForm } from '@/lib/jobs/forms';

const NOT_OWNER = 'Only the owner can manage the team.';
const PATH = '/admin/team';

export async function inviteMember(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(await actionRefusal(NOT_OWNER));

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

/**
 * "Add a person" with no email: they sign in by tapping their name on the sign-in page and typing
 * their PIN. Makes their login (made-up address, password derived from the PIN: lib/auth/pin.ts),
 * then their profile, listed for PIN sign-in, and the crews chosen on the form. The login is
 * removed again if the profile cannot be saved.
 */
export async function addPinMember(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(await actionRefusal(NOT_OWNER));
  const secret = serverEnv.pinSecret();
  if (!secret) return failure(PIN_OFF_FOR_OWNER);

  const obj = formToObject(fd);
  const parsed = parseWith(pinMemberForm, obj);
  if (!parsed.ok) return failure(parsed.error);
  const { full_name, role, pin } = parsed.data;

  const db = await createClient();
  const [listed, crews] = await Promise.all([db.from('profiles').select('full_name').eq('active', true).eq('pin_sign_in', true), db.from('crews').select('id')]);
  if (listed.error) return failure(`Loading the team failed: ${listed.error.message}`);
  if (crews.error) return failure(`Loading crews failed: ${crews.error.message}`);
  if (pinNameTaken((listed.data ?? []).map((p) => String((p as { full_name: unknown }).full_name)), full_name)) {
    return failure(`Someone on the sign-in page is already called ${full_name}. Add a last name or an initial so people can tell the names apart.`);
  }
  const crewIds = (crews.data ?? []).map((c) => String((c as { id: unknown }).id)).filter((id) => crewFieldName(id) in obj);
  const choices = parseCrewChoices(obj, crewIds);
  if (!choices.ok) return failure(choices.error);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return failure(`Adding people is not configured on this server: ${errorMessage(e)}`);
  }
  const login = await createPinLogin(admin, { fullName: full_name, pin, secret });
  if (!login.ok) return failure(`${full_name} could not be added: ${login.error}`);

  const insert = await db.from('profiles').insert({ id: login.userId, full_name, email: null, role, active: true, pin_sign_in: true });
  if (insert.error) {
    // Do not leave a login with no profile behind.
    await admin.auth.admin.deleteUser(login.userId).catch(() => undefined);
    return failure(`${full_name} was not added because the team profile could not be saved: ${insert.error.message}`);
  }
  revalidatePath(PATH);
  if (choices.memberships.length) {
    const crew = await db
      .from('crew_members')
      .insert(choices.memberships.map((m) => ({ crew_id: m.crewId, profile_id: login.userId, is_lead: m.isLead })));
    if (crew.error) return failure(`${full_name} was added, but their crews were not saved: ${crew.error.message}. Set them in the list below.`);
  }
  return success(`Added ${full_name}. They sign in by tapping their name and entering the PIN.`);
}

/** "Reset PIN": the owner gives a PIN person a new PIN (1234 unless they type another) and clears their lock. */
export async function resetMemberPin(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(await actionRefusal(NOT_OWNER));
  const secret = serverEnv.pinSecret();
  if (!secret) return failure(PIN_OFF_FOR_OWNER);

  const parsed = parseWith(resetPinForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { id, pin } = parsed.data;
  if (id === profile.userId) return failure('Change your own PIN with "Change my PIN" in your menu.');

  const db = await createClient();
  const person = await db.from('profiles').select('full_name, pin_sign_in').eq('id', id).maybeSingle();
  if (person.error) return failure(`Loading that team member failed: ${person.error.message}`);
  const p = person.data as { full_name: string; pin_sign_in: boolean } | null;
  if (!p) return failure('That team member was not found.');
  if (!p.pin_sign_in) return failure(`${p.full_name} signs in with email, not a PIN.`);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return failure(`Resetting PINs is not configured on this server: ${errorMessage(e)}`);
  }
  const failed = await setPin(admin, id, pin, secret);
  if (failed) return failure(`The PIN was not changed: ${failed}`);
  revalidatePath(PATH);
  return success(`New PIN set for ${p.full_name}. The old PIN no longer works, and any lock is cleared.`);
}

export async function updateMember(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(await actionRefusal(NOT_OWNER));

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
  if (!profile || profile.role !== 'owner') return failure(await actionRefusal(NOT_OWNER));

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

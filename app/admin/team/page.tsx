import type { Metadata } from 'next';
import { z } from 'zod';
import { AppNav } from '@/components/AppNav';
import { Alert, Badge, Card, Field, Select } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { ROLE_LABELS, ROLES } from '@/lib/admin/team';
import { crewFieldName } from '@/lib/jobs/forms';
import { ActionForm, ToggleInput } from '../pricing/ActionForm';
import { TextField } from '../pricing/fields';
import { inviteMember, updateCrewMembership, updateMember } from './actions';

export const metadata: Metadata = { title: 'Team' };

const profileRows = z.array(
  z.object({
    id: z.string(),
    full_name: z.string(),
    email: z.string().nullable(),
    role: z.enum(ROLES),
    active: z.boolean(),
  }),
);

const crewRows = z.array(z.object({ id: z.string(), name: z.string(), active: z.boolean() }));
const membershipRows = z.array(z.object({ crew_id: z.string(), profile_id: z.string(), is_lead: z.boolean() }));
type Crew = z.infer<typeof crewRows>[number];

const ROLE_HELP: Record<(typeof ROLES)[number], string> = {
  owner: 'Everything, including pricing and the team',
  office: 'All estimates and quotes; pricing read-only',
  estimator: 'Own estimates and quotes in the field app',
  crew: 'Assigned jobs only; never sees prices',
};

function RoleSelect({ name, defaultValue }: { name: string; defaultValue: string }) {
  return (
    <Select name={name} defaultValue={defaultValue} required>
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </Select>
  );
}

export default async function TeamPage() {
  const profile = await requireRole('owner');
  const db = await createClient();
  const [res, crewsRes, membershipRes] = await Promise.all([
    db.from('profiles').select('id, full_name, email, role, active').order('active', { ascending: false }).order('full_name'),
    db.from('crews').select('id, name, active').order('name'),
    db.from('crew_members').select('crew_id, profile_id, is_lead'),
  ]);
  const parsed = res.error ? null : profileRows.safeParse(res.data);
  const members = parsed?.success ? parsed.data : null;
  const crews = crewRows.safeParse(crewsRes.data ?? []).data ?? [];
  // profile id -> crew id -> is lead
  const memberships = new Map<string, Map<string, boolean>>();
  for (const m of membershipRows.safeParse(membershipRes.data ?? []).data ?? []) {
    const mine = memberships.get(m.profile_id) ?? new Map<string, boolean>();
    mine.set(m.crew_id, m.is_lead);
    memberships.set(m.profile_id, mine);
  }

  return (
    <>
      <AppNav profile={profile} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <h1 className="text-2xl font-bold text-slate-900">Team</h1>

        <Card>
          <h2 className="mb-1 text-lg font-semibold text-slate-900">Invite someone</h2>
          <p className="mb-3 text-sm text-slate-600">They get an email with a link to sign in. They can then sign in with a one-time code.</p>
          <ActionForm action={inviteMember} readOnly={false} submitLabel="Send invite" resetOnSuccess>
            <div className="grid gap-3 md:grid-cols-3">
              <TextField label="Full name" name="full_name" defaultValue="" required />
              <TextField label="Email" name="email" type="email" defaultValue="" required />
              <Field label="Role">
                <RoleSelect name="role" defaultValue="estimator" />
              </Field>
            </div>
            <ul className="grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
              {ROLES.map((r) => (
                <li key={r}>
                  <strong className="text-slate-700">{ROLE_LABELS[r]}:</strong> {ROLE_HELP[r]}
                </li>
              ))}
            </ul>
          </ActionForm>
        </Card>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">People{members ? ` (${members.length})` : ''}</h2>
          {!members ? (
            <Alert tone="red">Could not load the team: {res.error?.message ?? 'unexpected data'}</Alert>
          ) : members.length === 0 ? (
            <Alert tone="blue">No one on the team yet.</Alert>
          ) : (
            <ul className="space-y-3">
              {members.map((m) => {
                const isSelf = m.id === profile.userId;
                return (
                  <li key={m.id}>
                    <Card className={m.active ? undefined : 'bg-slate-50'}>
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{m.full_name}</span>
                        {isSelf ? <Badge tone="blue">You</Badge> : null}
                        <Badge tone={m.role === 'owner' ? 'green' : 'slate'}>{ROLE_LABELS[m.role]}</Badge>
                        {!m.active ? <Badge tone="red">Inactive</Badge> : null}
                        <span className="w-full break-all text-sm text-slate-600 sm:w-auto">{m.email ?? 'No email'}</span>
                      </div>
                      {isSelf ? (
                        <p className="text-sm text-slate-500">You cannot change your own role or deactivate yourself.</p>
                      ) : (
                        <ActionForm action={updateMember} readOnly={false}>
                          <input type="hidden" name="id" value={m.id} />
                          <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
                            <Field label={`Role for ${m.full_name}`}>
                              <RoleSelect name="role" defaultValue={m.role} />
                            </Field>
                            <ToggleInput name="active" label="Active" hint="Inactive people cannot sign in to the app" defaultChecked={m.active} />
                          </div>
                        </ActionForm>
                      )}
                      <CrewMembership memberId={m.id} name={m.full_name} isCrew={m.role === 'crew'} crews={crews} current={memberships.get(m.id) ?? new Map()} />
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

/**
 * Which crews this person is on (crew users see only their crews' jobs) and whether they lead
 * it. Shown open for crew users; other roles can be added to a crew too (an owner who works jobs).
 */
function CrewMembership({ memberId, name, isCrew, crews, current }: { memberId: string; name: string; isCrew: boolean; crews: Crew[]; current: Map<string, boolean> }) {
  const shown = crews.filter((c) => c.active || current.has(c.id));
  const form =
    shown.length === 0 ? (
      <p className="text-sm text-slate-500">No crews yet. Add one on the Pricing page (Crews).</p>
    ) : (
      <ActionForm action={updateCrewMembership} readOnly={false} submitLabel="Save crews">
        <input type="hidden" name="profile_id" value={memberId} />
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((c) => (
            <Field key={c.id} label={`${c.name}${c.active ? '' : ' (inactive)'} for ${name}`}>
              <Select name={crewFieldName(c.id)} defaultValue={current.has(c.id) ? (current.get(c.id) ? 'lead' : 'member') : 'none'}>
                <option value="none">Not in this crew</option>
                <option value="member">Member</option>
                <option value="lead">Crew lead</option>
              </Select>
            </Field>
          ))}
        </div>
      </ActionForm>
    );
  if (isCrew) {
    return (
      <div className="mt-4 border-t border-slate-100 pt-3">
        <h3 className="mb-2 text-sm font-semibold text-slate-800">Crews</h3>
        {current.size === 0 && shown.length ? (
          <div className="mb-3">
            <Alert tone="amber">Not on any crew yet: {name} will not see any jobs.</Alert>
          </div>
        ) : null}
        {form}
      </div>
    );
  }
  return (
    <details className="mt-4 border-t border-slate-100 pt-3" open={current.size > 0}>
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-slate-800">Crews{current.size ? ` (${current.size})` : ' (optional)'}</summary>
      <div className="mt-2">{form}</div>
    </details>
  );
}

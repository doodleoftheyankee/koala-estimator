'use server';
// Office/owner actions on jobs. Every action re-checks the caller's role, validates with zod,
// and writes with the signed-in user's client so staff RLS and the audit triggers apply.
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getSessionProfile, type SessionProfile } from '@/lib/server/auth';
import { failure, formToObject, parseWith, success, UNIQUE_VIOLATION, type ActionResult } from '@/lib/admin/forms';
import { actualCosts, actualForm, actualValues, excludeForm, jobIdForm, scheduleForm, statusForm, valuesChanged } from '@/lib/jobs/forms';
import { JOB_STATUS_LABELS } from '@/lib/jobs/status';

type Db = Awaited<ReturnType<typeof createClient>>;

const NOT_STAFF = 'Only the office or the owner can change jobs.';

async function staff(): Promise<{ db: Db; profile: SessionProfile } | null> {
  const profile = await getSessionProfile();
  if (!profile || (profile.role !== 'owner' && profile.role !== 'office')) return null;
  return { db: await createClient(), profile };
}

function refresh(jobId: string) {
  revalidatePath('/jobs');
  revalidatePath(`/jobs/${jobId}`);
}

export async function saveSchedule(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await staff();
  if (!s) return failure(NOT_STAFF);
  const parsed = parseWith(scheduleForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { id, crew_id, scheduled_start, scheduled_days } = parsed.data;
  const res = await s.db.from('jobs').update({ crew_id, scheduled_start, scheduled_days }).eq('id', id).select('id');
  if (res.error) return failure(`Saving the schedule failed: ${res.error.message}`);
  if (!res.data?.length) return failure('That job was not found.');
  refresh(id);
  return success('Schedule saved.');
}

export async function changeStatus(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await staff();
  if (!s) return failure(NOT_STAFF);
  const parsed = parseWith(statusForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { id, status, confirm } = parsed.data;
  if (status === 'cancelled' && !confirm) return failure('Tick the box to confirm cancelling this job.');
  const res = await s.db.rpc('crew_set_job_status', { p_job_id: id, p_status: status });
  if (res.error) {
    if (res.error.code === '22023') return failure(`This job cannot move to ${JOB_STATUS_LABELS[status].toLowerCase()} from its current status. Reload the page.`);
    if (res.error.code === 'P0002') return failure('That job was not found.');
    return failure(`Changing the status failed: ${res.error.message}`);
  }
  refresh(id);
  return success(`Marked ${JOB_STATUS_LABELS[status].toLowerCase()}.`);
}

/**
 * The office enters or corrects one actuals row. Costs can change at any time; quantities and
 * hours of a verified row only after the owner unverifies the job (verification is what feeds
 * learning, so verified numbers must not drift).
 */
export async function saveActual(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await staff();
  if (!s) return failure(NOT_STAFF);
  const parsed = parseWith(actualForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const f = parsed.data;
  const values = actualValues(f);
  const costs = actualCosts(f);

  if (f.id) {
    const cur = await s.db
      .from('job_actuals')
      .select('job_id, verified_at, actual_material_qty, actual_material_unit, actual_hours, actual_crew_size, actual_drive_minutes, actual_days, notes')
      .eq('id', f.id)
      .maybeSingle();
    if (cur.error) return failure(`Loading the row failed: ${cur.error.message}`);
    const row = cur.data as Record<string, unknown> | null;
    if (!row || row.job_id !== f.job_id) return failure('That actuals row was not found. Reload the page.');
    const changed = valuesChanged(values, row);
    if (changed && row.verified_at) return failure('This row is verified. The owner must unverify the job before quantities, hours or notes change.');
    const patch = changed ? { ...costs, ...values, entered_by: s.profile.userId, entered_at: new Date().toISOString() } : costs;
    const res = await s.db.from('job_actuals').update(patch).eq('id', f.id).select('id');
    if (res.error) return failure(`Saving failed: ${res.error.message}`);
    if (!res.data?.length) return failure('That actuals row was not found. Reload the page.');
  } else {
    const job = await s.db.from('jobs').select('estimate_id').eq('id', f.job_id).maybeSingle();
    if (job.error || !job.data) return failure('That job was not found.');
    if (f.area_id) {
      // The table only checks that the area exists; make sure it is this job's.
      const estimateId = (job.data as { estimate_id: string }).estimate_id;
      const area = await s.db.from('estimate_areas').select('id').eq('id', f.area_id).eq('estimate_id', estimateId).maybeSingle();
      if (area.error || !area.data) return failure('That area is not part of this job.');
    }
    const res = await s.db.from('job_actuals').insert({
      id: crypto.randomUUID(),
      job_id: f.job_id,
      area_id: f.area_id,
      product: f.product,
      ...values,
      ...costs,
      entered_by: s.profile.userId,
    });
    if (res.error) {
      if (res.error.code === UNIQUE_VIOLATION) return failure('Actuals for this area and product already exist (perhaps the crew just synced). Reload the page.');
      return failure(`Saving failed: ${res.error.message}`);
    }
  }
  refresh(f.job_id);
  return success();
}

export async function verifyActuals(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await staff();
  if (!s) return failure(NOT_STAFF);
  const parsed = parseWith(jobIdForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { id } = parsed.data;
  const job = await s.db.from('jobs').select('status').eq('id', id).maybeSingle();
  if (job.error || !job.data) return failure('That job was not found.');
  if ((job.data as { status: string }).status !== 'completed') return failure('Only completed jobs can be verified.');
  const res = await s.db
    .from('job_actuals')
    .update({ verified_by: s.profile.userId, verified_at: new Date().toISOString() })
    .eq('job_id', id)
    .is('verified_at', null)
    .select('id');
  if (res.error) return failure(`Verifying failed: ${res.error.message}`);
  if (!res.data?.length) {
    const any = await s.db.from('job_actuals').select('id', { count: 'exact', head: true }).eq('job_id', id);
    return failure(any.count ? 'Every row is already verified.' : 'There are no actuals to verify yet.');
  }
  refresh(id);
  return success(`Verified ${res.data.length} row${res.data.length === 1 ? '' : 's'}. They now feed the nightly learning run.`);
}

export async function unverifyActuals(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure('Only the owner can unverify actuals.');
  const parsed = parseWith(jobIdForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { id } = parsed.data;
  const db = await createClient();
  const res = await db.from('job_actuals').update({ verified_by: null, verified_at: null }).eq('job_id', id).not('verified_at', 'is', null).select('id');
  if (res.error) return failure(`Unverifying failed: ${res.error.message}`);
  if (!res.data?.length) return failure('Nothing was verified.');
  refresh(id);
  return success('Unverified. The crew and office can edit the actuals again.');
}

export async function setExcluded(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await staff();
  if (!s) return failure(NOT_STAFF);
  const parsed = parseWith(excludeForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { job_id, id, exclude, reason } = parsed.data;
  const res = await s.db
    .from('job_actuals')
    .update({ exclude_from_learning: exclude, exclude_reason: exclude ? reason : null })
    .eq('id', id)
    .eq('job_id', job_id)
    .select('id');
  if (res.error) return failure(`Saving failed: ${res.error.message}`);
  if (!res.data?.length) return failure('That actuals row was not found. Reload the page.');
  refresh(job_id);
  return success(exclude ? 'Left out of learning.' : 'Included in learning again.');
}

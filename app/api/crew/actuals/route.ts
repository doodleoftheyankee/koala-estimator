// POST /api/crew/actuals {mutationId, jobId, rows}: one offline actuals edit from the crew app.
// Applied by sync_job_actuals() as the signed-in user (RLS: crews write only their own jobs'
// unverified rows and can never set costs or verification). Idempotent on mutationId.
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { actualsBodySchema, LOCKED_MESSAGE, toDbActualRow, type ActualsSyncResponse } from '@/lib/jobs/crew';
import { authorize } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const reply = (body: ActualsSyncResponse, status = 200) => NextResponse.json(body, { status });

const resultSchema = z.object({ status: z.enum(['applied', 'locked']), rows: z.number().optional() });

export async function POST(request: NextRequest) {
  const { error } = await authorize('crew', 'owner', 'office');
  if (error) return error;

  const parsed = actualsBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
    return reply({ status: 'invalid', error: msg || 'Malformed actuals' }, 400);
  }
  const { mutationId, jobId, rows } = parsed.data;
  const supabase = await createClient();

  // The job must be one of this user's (the view is scoped to the user's crews), and every
  // area must belong to it; the actuals table only checks that the area exists.
  const view = await supabase.from('crew_job_view').select('area_id').eq('job_id', jobId);
  if (view.error) return reply({ status: 'error', error: `Could not load the job: ${view.error.message}` }, 500);
  const areas = new Set((view.data ?? []).map((r) => String((r as { area_id: unknown }).area_id)));
  if (areas.size === 0) return reply({ status: 'invalid', error: 'This job is no longer assigned to your crew. Ask the office.' }, 403);
  const stray = rows.find((r) => r.areaId !== null && !areas.has(r.areaId));
  if (stray) return reply({ status: 'invalid', error: 'An area in these actuals is not part of this job.' }, 422);

  const { data, error: rpcError } = await supabase.rpc('sync_job_actuals', {
    p_mutation_id: mutationId,
    p_job_id: jobId,
    p_rows: rows.map(toDbActualRow),
  });
  if (rpcError) {
    if (rpcError.code === '23505') {
      // Same area x product saved under another id (another phone, or the office).
      if (await jobVerified(jobId)) return reply({ status: 'locked', error: LOCKED_MESSAGE }, 409);
      return reply({ status: 'conflict', error: 'These actuals were also entered elsewhere. Refreshing and trying again.' }, 409);
    }
    if (rpcError.code === '42501' || /row-level security/i.test(rpcError.message)) {
      return reply({ status: 'invalid', error: 'You cannot enter actuals for this job.' }, 403);
    }
    return reply({ status: 'error', error: rpcError.message }, 500);
  }

  const result = resultSchema.safeParse(data);
  if (!result.success) return reply({ status: 'error', error: 'Unexpected answer from the database.' }, 500);
  if (result.data.status === 'locked') return reply({ status: 'locked', error: LOCKED_MESSAGE }, 409);
  const applied = result.data.rows ?? 0;
  // Verified rows are skipped (and invisible to crews), so fewer rows than sent means locked.
  if (applied < rows.length && (await jobVerified(jobId))) return reply({ status: 'locked', error: LOCKED_MESSAGE }, 409);
  return reply({ status: 'applied', rows: applied });
}

/**
 * Has the office verified any of this job's actuals? Crew RLS hides verified rows, so this asks
 * with the service role; the caller already proved the job is theirs through crew_job_view.
 */
async function jobVerified(jobId: string): Promise<boolean> {
  try {
    const { count, error } = await createAdminClient()
      .from('job_actuals')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', jobId)
      .not('verified_at', 'is', null);
    return !error && (count ?? 0) > 0;
  } catch {
    return false;
  }
}

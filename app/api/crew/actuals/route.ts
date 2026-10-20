// POST /api/crew/actuals {mutationId, jobId, rows}: one offline actuals edit from the crew app.
// Applied by sync_job_actuals() as the signed-in user: crews have no direct table access, and the
// function never takes costs, exclusions or verification from a phone. Only the rows the crew
// changed are sent, each with the server version it is based on; rows changed on the server
// meanwhile come back as conflicts for the phone to merge. Idempotent on mutationId.
import { NextResponse, type NextRequest } from 'next/server';
import { actualsBodySchema, fromSyncResult, syncActualsResultSchema, toDbActualRow, type ActualsSyncResponse } from '@/lib/jobs/crew';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const reply = (body: ActualsSyncResponse, status = 200) => NextResponse.json(body, { status });

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

  const { data, error: rpcError } = await supabase.rpc('sync_job_actuals', {
    p_mutation_id: mutationId,
    p_job_id: jobId,
    p_rows: rows.map(toDbActualRow),
  });
  if (rpcError) {
    // Not (or no longer) this crew's job. Retryable, not a data error: the office may assign the
    // job back, and the draft must still be there when it does.
    if (rpcError.code === '42501') {
      return reply({ status: 'error', error: 'This job is not assigned to your crew right now. Ask the office; your actuals stay on this phone.' }, 403);
    }
    if (rpcError.code === '22023' || rpcError.code === '23503') {
      return reply({ status: 'invalid', error: 'An area in these actuals is not part of this job. Pull to refresh the job.' }, 422);
    }
    // Two phones created the same area x product at the same moment: pull, merge, send again.
    if (rpcError.code === '23505') {
      return reply({ status: 'conflict', error: 'These actuals were also entered on another phone. Refreshing and trying again.' }, 409);
    }
    return reply({ status: 'error', error: rpcError.message }, 500);
  }

  const result = syncActualsResultSchema.safeParse(data);
  if (!result.success) return reply({ status: 'error', error: 'Unexpected answer from the database.' }, 500);
  const res = fromSyncResult(result.data);
  return reply(res, res.status === 'locked' ? 409 : 200);
}

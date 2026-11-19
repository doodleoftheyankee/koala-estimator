// Blower door readings saved to a job or an estimate.
//
//   GET  ?job=<id> | ?estimate=<id>   who the readings are for and the readings saved to it
//                                     (blower_door_context: the same access as the job or estimate)
//   POST {mutationId, test}           one reading from the phone's outbox (sync_blower_door_test:
//                                     idempotent on mutationId and on the reading's id, so a
//                                     reading sent twice is stored once)
//
// Everything goes through the signed-in user's client, so the database decides who may see and
// record what: owner and office every job, an estimator their own estimates, a crew lead only their
// crew's jobs.
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { contextResponseSchema, newTestSchema, testSyncResponseSchema, toRpcTest, type ContextResponse, type TestSyncResponse } from '@/lib/blowerdoor';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const ROLES = ['owner', 'office', 'estimator', 'crew'] as const;

export async function GET(request: NextRequest) {
  const { error } = await authorize(...ROLES);
  if (error) return error;
  const params = request.nextUrl.searchParams;
  const job = z.guid().safeParse(params.get('job'));
  const estimate = z.guid().safeParse(params.get('estimate'));
  if (job.success === estimate.success) return NextResponse.json({ error: 'Give a job or an estimate.' }, { status: 400 });

  const supabase = await createClient();
  const { data, error: rpcError } = await supabase.rpc('blower_door_context', {
    p_job_id: job.success ? job.data : null,
    p_estimate_id: estimate.success ? estimate.data : null,
  });
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });
  if (data === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const raw = data as { job_id?: unknown; estimate_id?: unknown; label?: unknown; tests?: unknown };
  const parsed = contextResponseSchema.safeParse({ jobId: raw.job_id ?? null, estimateId: raw.estimate_id, label: raw.label ?? null, tests: raw.tests ?? [] });
  if (!parsed.success) return NextResponse.json({ error: 'Unexpected answer from the database.' }, { status: 500 });
  return NextResponse.json(parsed.data satisfies ContextResponse, { headers: { 'Cache-Control': 'private, no-store' } });
}

const bodySchema = z.object({ mutationId: z.guid(), test: z.unknown() });
const reply = (body: TestSyncResponse, status = 200) => NextResponse.json(body, { status });

export async function POST(request: NextRequest) {
  const { error } = await authorize(...ROLES);
  if (error) return error;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return reply({ status: 'invalid', error: 'Malformed reading.' }, 400);
  const test = newTestSchema.safeParse(body.data.test);
  if (!test.success) {
    const msg = [...new Set(test.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)))].join('; ');
    return reply({ status: 'invalid', error: msg || 'Malformed reading.' }, 422);
  }

  const supabase = await createClient();
  const { data, error: rpcError } = await supabase.rpc('sync_blower_door_test', { p_mutation_id: body.data.mutationId, p_test: toRpcTest(test.data) });
  if (rpcError) {
    if (rpcError.code === '28000') return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    // A deactivated or re-roled account: keep the reading on the phone.
    if (rpcError.code === '42501') return reply({ status: 'refused', error: 'Your account cannot save blower door tests right now. The reading stays on this phone.' }, 403);
    return reply({ status: 'error', error: rpcError.message }, 500);
  }
  const result = testSyncResponseSchema.safeParse(data);
  if (!result.success) return reply({ status: 'error', error: 'Unexpected answer from the database.' }, 500);
  return reply(result.data);
}

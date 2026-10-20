// POST /api/crew/jobs/:id/status {status}: start or complete a job (office/owner may also cancel
// or reopen). The transition rules and the crew-membership check live in crew_set_job_status().
// Completing from the crew app also requires complete actuals, so a job never reaches the
// office without hours and quantities.
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  actualDbRowSchema,
  CREW_ACTUAL_COLUMNS,
  CREW_VIEW_COLUMNS,
  crewViewRowSchema,
  groupViewRows,
  toServerActual,
} from '@/lib/jobs/crew';
import { JOB_STATUS_LABELS, JOB_STATUSES, isJobStatus } from '@/lib/jobs/status';
import { completionBlockers } from '@/lib/offline/crewSyncCore';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ status: z.enum(JOB_STATUSES) });

const resultSchema = z.object({
  status: z.enum(JOB_STATUSES),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { error } = await authorize('crew', 'owner', 'office');
  if (error) return error;
  const { id } = await ctx.params;
  if (!z.guid().safeParse(id).success) return NextResponse.json({ error: 'Unknown job' }, { status: 404 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Send {"status": "in_progress" | "completed" | ...}' }, { status: 400 });
  const { status } = body.data;

  const supabase = await createClient();

  if (status === 'completed') {
    let blockers: string[] | null;
    try {
      blockers = await completionCheck(supabase, id);
    } catch (e) {
      return NextResponse.json({ error: `Could not check the actuals: ${(e as Error).message}` }, { status: 500 });
    }
    if (blockers === null) return NextResponse.json({ error: 'This job is not assigned to your crew.' }, { status: 404 });
    if (blockers.length) {
      return NextResponse.json({ error: 'Finish the actuals before completing the job.', blockers }, { status: 409 });
    }
  }

  const { data, error: rpcError } = await supabase.rpc('crew_set_job_status', { p_job_id: id, p_status: status });
  if (rpcError) {
    if (rpcError.code === 'P0002') return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    if (rpcError.code === '42501') return NextResponse.json({ error: 'This job is not assigned to your crew.' }, { status: 403 });
    if (rpcError.code === '22023') {
      const from = /from (\w+) to/.exec(rpcError.message)?.[1];
      const label = isJobStatus(from) ? JOB_STATUS_LABELS[from].toLowerCase() : 'its current status';
      return NextResponse.json({ error: `This job cannot go from ${label} to ${JOB_STATUS_LABELS[status].toLowerCase()}. Pull to refresh.` }, { status: 409 });
    }
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }
  const result = resultSchema.safeParse(data);
  if (!result.success) return NextResponse.json({ error: 'Unexpected answer from the database.' }, { status: 500 });
  return NextResponse.json({ status: result.data.status, startedAt: result.data.started_at, completedAt: result.data.completed_at });
}

/** What is still missing from the job's stored actuals; null when the user cannot see the job. */
async function completionCheck(supabase: Awaited<ReturnType<typeof createClient>>, jobId: string): Promise<string[] | null> {
  const view = await supabase.from('crew_job_view').select(CREW_VIEW_COLUMNS).eq('job_id', jobId);
  const rows = z.array(crewViewRowSchema).safeParse(view.data ?? []);
  if (view.error || !rows.success) throw new Error(view.error?.message ?? 'Unexpected job data');
  const job = groupViewRows(rows.data)[0];
  if (!job) return null;
  const actuals = await supabase.from('job_actuals').select(CREW_ACTUAL_COLUMNS).eq('job_id', jobId);
  const parsed = z.array(actualDbRowSchema).safeParse(actuals.data ?? []);
  if (actuals.error || !parsed.success) throw new Error(actuals.error?.message ?? 'Unexpected actuals data');
  return completionBlockers(job, parsed.data.map(toServerActual));
}

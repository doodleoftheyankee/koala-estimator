// GET /api/crew/jobs: the signed-in crew's jobs for the offline crew app. Scheduled and in-progress
// jobs, plus jobs completed in the last 14 days (New York dates), each with its signed scope
// (quantities and hours, never money) and the actuals entered so far (no cost columns).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recentCutoffIso } from '@/lib/jobs/dates';
import {
  actualDbRowSchema,
  CREW_ACTUAL_COLUMNS,
  CREW_VIEW_COLUMNS,
  crewViewRowSchema,
  groupViewRows,
  toServerActual,
  type ActualDbRow,
  type CrewJobsResponse,
} from '@/lib/jobs/crew';
import { authorize } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const RECENT_DAYS = 14;

export async function GET() {
  const { profile, error } = await authorize('crew', 'owner', 'office');
  if (error) return error;
  const supabase = await createClient();

  // crew_job_view only returns jobs of crews the user belongs to (owner/office see all).
  const cutoff = recentCutoffIso(new Date(), RECENT_DAYS);
  const view = await supabase
    .from('crew_job_view')
    .select(CREW_VIEW_COLUMNS)
    .or(`status.in.(scheduled,in_progress),and(status.eq.completed,completed_at.gte."${cutoff}")`)
    .order('scheduled_start', { ascending: true, nullsFirst: false })
    .order('job_id')
    .order('area_sort')
    .limit(1000);
  if (view.error) return NextResponse.json({ error: `Could not load jobs: ${view.error.message}` }, { status: 500 });
  const rows = z.array(crewViewRowSchema).safeParse(view.data);
  if (!rows.success) return NextResponse.json({ error: 'Unexpected job data from the server.' }, { status: 500 });
  const jobs = groupViewRows(rows.data);
  const ids = jobs.map((j) => j.jobId);

  // RLS: crews read their own jobs' unverified rows; owner/office read everything.
  let actuals: ActualDbRow[] = [];
  if (ids.length) {
    const res = await supabase.from('job_actuals').select(CREW_ACTUAL_COLUMNS).in('job_id', ids).order('entered_at');
    if (res.error) return NextResponse.json({ error: `Could not load actuals: ${res.error.message}` }, { status: 500 });
    const parsed = z.array(actualDbRowSchema).safeParse(res.data);
    if (!parsed.success) return NextResponse.json({ error: 'Unexpected actuals data from the server.' }, { status: 500 });
    actuals = parsed.data;
  }

  const verified = new Set(actuals.filter((a) => a.verified_at !== null).map((a) => a.job_id));
  if (profile.role === 'crew') for (const id of await verifiedForCrew(ids)) verified.add(id);

  const body: CrewJobsResponse = {
    jobs: jobs.map((j) => ({
      ...j,
      actuals: actuals.filter((a) => a.job_id === j.jobId).map(toServerActual),
      verified: verified.has(j.jobId),
    })),
    fetchedAt: new Date().toISOString(),
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Crew RLS hides verified rows, so the crew's own client cannot tell "verified" from "nothing
 * entered". The ids come from the crew-scoped view above, so this only reveals a yes/no about
 * jobs the user may already see.
 */
async function verifiedForCrew(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  try {
    const { data, error } = await createAdminClient().from('job_actuals').select('job_id').in('job_id', ids).not('verified_at', 'is', null);
    if (error) return [];
    return (data ?? []).map((r) => String((r as { job_id: unknown }).job_id));
  } catch {
    return []; // service role not configured: the crew learns about verification on its next sync
  }
}

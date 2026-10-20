import type { Metadata } from 'next';
import { z } from 'zod';
import { AppNav } from '@/components/AppNav';
import { Alert, Badge, Card } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Crew' };

// crew_job_view has one row per job area; group them back into jobs.
const viewRows = z.array(
  z.object({
    job_id: z.string(),
    status: z.string(),
    scheduled_start: z.string().nullable(),
    street: z.string(),
    city: z.string(),
    area_name: z.string().nullable(),
  }),
);

const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

/** Today's date in Newark (YYYY-MM-DD), to compare with scheduled_start (a date column). */
function todayInNewark(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

export default async function CrewPage() {
  const profile = await requireRole('crew', 'owner', 'office');
  const db = await createClient();
  const res = await db
    .from('crew_job_view')
    .select('job_id, status, scheduled_start, street, city, area_name')
    .in('status', ['scheduled', 'in_progress'])
    .or(`scheduled_start.gte.${todayInNewark()},scheduled_start.is.null,status.eq.in_progress`)
    .order('scheduled_start', { ascending: true, nullsFirst: false })
    .limit(500);

  const parsed = res.error ? null : viewRows.safeParse(res.data);
  const jobs = new Map<string, { id: string; status: string; start: string | null; address: string; areas: string[] }>();
  if (parsed?.success) {
    for (const r of parsed.data) {
      const job = jobs.get(r.job_id) ?? { id: r.job_id, status: r.status, start: r.scheduled_start, address: `${r.street}, ${r.city}`, areas: [] };
      if (r.area_name && !job.areas.includes(r.area_name)) job.areas.push(r.area_name);
      jobs.set(r.job_id, job);
    }
  }
  const list = [...jobs.values()];

  return (
    <>
      <AppNav profile={profile} />
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
        <h1 className="text-2xl font-bold text-slate-900">Crew</h1>
        <Alert tone="blue">
          Assigned jobs with full details and entering job actuals (hours, materials used) arrive in Phase 2. For now this page lists upcoming jobs.
        </Alert>

        {res.error || (parsed && !parsed.success) ? (
          <Alert tone="red">Could not load jobs: {res.error?.message ?? 'unexpected data'}</Alert>
        ) : list.length === 0 ? (
          <Card>
            <p className="text-slate-600">No upcoming jobs{profile.role === 'crew' ? ' assigned to your crew' : ''}.</p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {list.map((j) => (
              <li key={j.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{j.start ? day.format(new Date(`${j.start}T00:00:00Z`)) : 'Not scheduled yet'}</p>
                      <p className="text-slate-700">{j.address}</p>
                    </div>
                    <Badge tone={j.status === 'in_progress' ? 'amber' : 'blue'}>{j.status === 'in_progress' ? 'In progress' : 'Scheduled'}</Badge>
                  </div>
                  {j.areas.length ? <p className="mt-2 text-sm text-slate-600">Areas: {j.areas.join(', ')}</p> : null}
                  <p className="mt-2 text-xs text-slate-400">Job {j.id.slice(0, 8)}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

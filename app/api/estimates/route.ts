import { NextResponse } from 'next/server';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import type { RemoteEstimate } from '@/lib/sync/protocol';

// Recent estimates for the phone to hydrate from (another device, or a cleared cache).
export async function GET() {
  const { profile, error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;
  const supabase = await createClient();
  let q = supabase
    .from('estimates')
    .select('id, status, row_version, updated_at, client_doc')
    .not('client_doc', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(100);
  // Owner/office can see everything; on the phone they still only want their own work.
  if (profile.role !== 'estimator') q = q.eq('estimator_id', profile.userId);
  const { data, error: dbError } = await q;
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  const rows: RemoteEstimate[] = (data ?? []).map((r) => ({
    id: r.id as string,
    status: r.status as string,
    rowVersion: r.row_version as number,
    updatedAt: r.updated_at as string,
    doc: r.client_doc,
  }));
  return NextResponse.json({ estimates: rows });
}

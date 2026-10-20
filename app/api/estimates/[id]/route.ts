import { NextResponse, type NextRequest } from 'next/server';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import type { RemoteEstimate } from '@/lib/sync/protocol';

// One estimate (RLS-scoped), so office staff can open any estimate from the list in the field app.
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data, error: dbError } = await supabase
    .from('estimates')
    .select('id, status, row_version, updated_at, client_doc')
    .eq('id', id)
    .maybeSingle();
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  if (!data || !data.client_doc) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const row: RemoteEstimate = {
    id: data.id as string,
    status: data.status as string,
    rowVersion: data.row_version as number,
    updatedAt: data.updated_at as string,
    doc: data.client_doc,
  };
  return NextResponse.json(row);
}

// PATCH /api/approvals/[id]  { decision: 'approved' | 'declined', note? }
// The owner or the office decides a waiting price request (L34). The database decides who may
// (price_approvals RLS: never your own request; below the floor margin, the owner only) and records
// who decided, in which role and when; this route says why in words when it refuses.
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { APPROVAL_COLUMNS, approvalFromRow } from '@/lib/quotes/approvals';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  decision: z.enum(['approved', 'declined']),
  note: z.string().trim().max(500).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { profile, error } = await authorize('owner', 'office');
  if (error) return error;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found', message: 'Request not found.' }, { status: 404 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid', message: 'Choose approve or decline.' }, { status: 400 });

  const db = await createClient();
  const { data: before, error: readError } = await db.from('price_approvals').select(APPROVAL_COLUMNS).eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: 'failed', message: readError.message }, { status: 500 });
  const current = approvalFromRow(before);
  if (!current) return NextResponse.json({ error: 'not_found', message: 'Request not found.' }, { status: 404 });
  if (current.status !== 'pending') {
    return NextResponse.json({ error: 'decided', message: `This request was already ${current.status}.`, approval: current }, { status: 409 });
  }
  if (current.requestedBy === profile.userId) {
    return NextResponse.json({ error: 'own_request', message: 'You asked for this price, so someone else decides it.' }, { status: 403 });
  }
  if (current.belowFloor && profile.role !== 'owner') {
    return NextResponse.json({ error: 'owner_only', message: 'Only the owner can decide a price below the floor margin.' }, { status: 403 });
  }

  const { data, error: updError } = await db
    .from('price_approvals')
    .update({ status: body.data.decision, decision_note: body.data.note || null, decided_by: profile.userId })
    .eq('id', id)
    .eq('status', 'pending')
    .select(APPROVAL_COLUMNS)
    .maybeSingle();
  if (updError) {
    const denied = updError.code === '42501' || /row-level security/i.test(updError.message);
    return NextResponse.json({ error: denied ? 'forbidden' : 'failed', message: denied ? 'You cannot decide this request.' : updError.message }, { status: denied ? 403 : 500 });
  }
  if (!data) return NextResponse.json({ error: 'decided', message: 'This request was decided a moment ago.' }, { status: 409 });
  return NextResponse.json({ approval: approvalFromRow(data) });
}

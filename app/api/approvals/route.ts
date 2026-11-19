// Price approvals (L34, RF-02).
//   GET  /api/approvals?estimateId=…   an estimate's requests, newest first (staff, as RLS allows)
//   GET  /api/approvals                the requests waiting for a decision (owner and office)
//   POST /api/approvals                an estimator (or the office) asks for one option's price:
//                                      { estimateId, tier, price, note? }
// The request is checked against the estimate as the server prices it (lib/server/approvals.ts) and
// written as the signed-in user, so the database's rules apply (price_approvals RLS).
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { TIERS } from '@/lib/pricing';
import { APPROVAL_COLUMNS, approvalFromRow, approvalsFromRows, loadApprovals } from '@/lib/quotes/approvals';
import { checkApprovalRequest } from '@/lib/server/approvals';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const estimateId = request.nextUrl.searchParams.get('estimateId');
  const { profile, error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;
  const db = await createClient();
  try {
    if (estimateId) {
      if (!z.uuid().safeParse(estimateId).success) return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });
      return NextResponse.json({ approvals: await loadApprovals(db, estimateId) });
    }
    if (profile.role === 'estimator') return NextResponse.json({ error: 'Not allowed for your role' }, { status: 403 });
    const { data, error: dbError } = await db.from('price_approvals').select(APPROVAL_COLUMNS).eq('status', 'pending').order('requested_at', { ascending: true }).limit(100);
    if (dbError) throw new Error(dbError.message);
    return NextResponse.json({ approvals: approvalsFromRows(data) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

const bodySchema = z.object({
  estimateId: z.uuid(),
  tier: z.enum(TIERS),
  price: z.number().finite().positive(),
  note: z.string().trim().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const { profile, error } = await authorize('office', 'estimator');
  if (error) return error;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid', message: 'The request is not complete.' }, { status: 400 });
  const { estimateId, tier, price, note } = body.data;
  const db = await createClient();
  try {
    const check = await checkApprovalRequest(db, profile.role, estimateId, tier, price);
    if (!check.ok) return NextResponse.json({ error: check.error, message: check.message }, { status: check.status });
    const { problem } = check;
    const { data, error: insError } = await db
      .from('price_approvals')
      .insert({
        estimate_id: estimateId,
        tier,
        price: problem.price,
        model_price: problem.modelPrice,
        below_floor: problem.kind === 'below_floor',
        note: note || null,
        requested_by: profile.userId,
      })
      .select(APPROVAL_COLUMNS)
      .single();
    if (insError?.code === '23505') {
      // Already asked: the request waiting is the answer.
      const waiting = (await loadApprovals(db, estimateId)).find((a) => a.status === 'pending' && a.tier === tier && a.price === problem.price);
      return NextResponse.json({ approval: waiting ?? null, already: true });
    }
    if (insError) {
      const denied = insError.code === '42501' || /row-level security/i.test(insError.message);
      return NextResponse.json(
        { error: denied ? 'forbidden' : 'failed', message: denied ? 'You cannot ask for a price on this estimate.' : insError.message },
        { status: denied ? 403 : 500 },
      );
    }
    return NextResponse.json({ approval: approvalFromRow(data) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: 'failed', message: (e as Error).message }, { status: 500 });
  }
}

// GET /api/quotes/:id/pdf (staff): redirect to a short-lived signed URL for the quote PDF.
// ?signed=1 serves the signed copy when there is one.
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/server/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize('owner', 'office', 'estimator');
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

  try {
    // The user's client enforces RLS: estimators only see quotes for their own estimates.
    const supabase = await createClient();
    const { data, error } = await supabase.from('quotes').select('pdf_path, signed_pdf_path').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    const row = data as { pdf_path: string; signed_pdf_path: string | null };

    const wantSigned = request.nextUrl.searchParams.get('signed') === '1';
    const path = wantSigned && row.signed_pdf_path ? row.signed_pdf_path : row.pdf_path;

    const signed = await createAdminClient().storage.from('quotes').createSignedUrl(path, 60);
    if (signed.error || !signed.data) throw new Error(signed.error?.message ?? 'Could not sign the PDF URL');
    return NextResponse.redirect(signed.data.signedUrl, 302);
  } catch (e) {
    console.error('[quotes] pdf link failed', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not open the PDF' }, { status: 500 });
  }
}

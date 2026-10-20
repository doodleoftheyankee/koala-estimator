// GET /api/public/quotes/:token/pdf (customer): redirect to the signed copy when signed,
// otherwise the original quote PDF, through a 60-second signed URL.
import { NextResponse } from 'next/server';
import { findQuoteByToken } from '@/lib/quotes/lookup';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    const admin = createAdminClient();
    const quote = await findQuoteByToken(admin, token);
    if (!quote) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

    const path = quote.status === 'signed' && quote.signed_pdf_path ? quote.signed_pdf_path : quote.pdf_path;
    const signed = await admin.storage.from('quotes').createSignedUrl(path, 60);
    if (signed.error || !signed.data) throw new Error(signed.error?.message ?? 'Could not sign the PDF URL');
    return NextResponse.redirect(signed.data.signedUrl, 302);
  } catch (e) {
    console.error('[public quote] pdf link failed', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not open the PDF' }, { status: 500 });
  }
}

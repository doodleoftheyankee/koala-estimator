import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { businessInfo } from '@/lib/quotes/profile';
import { loadQuoteSettingRows } from '@/lib/quotes/settings';
import { authorize } from '@/lib/server/auth';
import { loadPricingBundle } from '@/lib/server/bundle';
import { createClient } from '@/lib/supabase/server';

// The pricing bundle the phone caches for offline pricing. Crew never receives it.
// It also carries the business profile's gaps and the town new estimates start in (outside the
// pricing hash, so a profile change never reprices anything); the ETag covers both, so the phone
// picks up a finished profile even when no price changed.
export async function GET(request: NextRequest) {
  const { error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;
  try {
    const supabase = await createClient();
    const [bundle, rows] = await Promise.all([loadPricingBundle(supabase), loadQuoteSettingRows(supabase)]);
    const business = businessInfo(rows);
    const etag = `"${bundle.hash}-${createHash('sha256').update(JSON.stringify(business)).digest('hex').slice(0, 12)}"`;
    if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    return NextResponse.json({ ...bundle, business, etag }, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } });
  } catch (e) {
    return NextResponse.json({ error: `Pricing is misconfigured: ${(e as Error).message}` }, { status: 500 });
  }
}

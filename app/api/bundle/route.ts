import { NextResponse, type NextRequest } from 'next/server';
import { authorize } from '@/lib/server/auth';
import { loadPricingBundle } from '@/lib/server/bundle';
import { createClient } from '@/lib/supabase/server';

// The pricing bundle the phone caches for offline pricing. Crew never receives it.
export async function GET(request: NextRequest) {
  const { error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;
  try {
    const bundle = await loadPricingBundle(await createClient());
    const etag = `"${bundle.hash}"`;
    if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    return NextResponse.json(bundle, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } });
  } catch (e) {
    return NextResponse.json({ error: `Pricing is misconfigured: ${(e as Error).message}` }, { status: 500 });
  }
}

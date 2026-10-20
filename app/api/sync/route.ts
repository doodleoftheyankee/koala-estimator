import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { priceEstimate } from '@/lib/pricing';
import { authorize } from '@/lib/server/auth';
import { loadPricingBundle } from '@/lib/server/bundle';
import { createClient } from '@/lib/supabase/server';
import { priceableAreas, syncableDraftSchema, toEstimateInput } from '@/lib/sync/draft';
import { buildSyncPayload } from '@/lib/sync/payload';
import type { SyncResponse } from '@/lib/sync/protocol';

const bodySchema = z.object({
  mutationId: z.uuid(),
  baseRowVersion: z.number().int().positive().nullable(),
  draft: z.unknown(),
});

/**
 * Applies one offline estimate edit. The server always re-prices with the current active
 * pricing bundle; the phone's numbers are never trusted. Idempotent on mutationId.
 */
export async function POST(request: NextRequest) {
  const { error } = await authorize('owner', 'office', 'estimator');
  if (error) return error;

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ status: 'invalid', error: 'Malformed sync request' } satisfies SyncResponse, { status: 400 });
  const parsed = syncableDraftSchema.safeParse(body.data.draft);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return NextResponse.json({ status: 'invalid', error: msg } satisfies SyncResponse, { status: 422 });
  }
  const draft = parsed.data;

  const supabase = await createClient();
  let payload;
  let bundleHash: string;
  try {
    const bundle = await loadPricingBundle(supabase);
    bundleHash = bundle.hash;
    const priced = priceEstimate({ ...toEstimateInput(draft), areas: priceableAreas(draft) }, bundle.snapshot, bundle.coefficientSet);
    payload = buildSyncPayload(draft, priced, bundle, { pricedOffline: draft.bundleHash !== bundle.hash });
  } catch (e) {
    return NextResponse.json({ status: 'error', error: `Could not price: ${(e as Error).message}` } satisfies SyncResponse, { status: 500 });
  }

  const { data, error: rpcError } = await supabase.rpc('sync_upsert_estimate', {
    p_mutation_id: body.data.mutationId,
    p_base_row_version: body.data.baseRowVersion,
    p_payload: payload,
  });
  if (rpcError) {
    const forbidden = rpcError.code === '42501' || /row-level security/i.test(rpcError.message);
    return NextResponse.json(
      { status: 'error', error: forbidden ? 'You do not have access to this estimate.' : rpcError.message } satisfies SyncResponse,
      { status: forbidden ? 403 : 500 },
    );
  }

  const result = data as { status: 'applied' | 'conflict' | 'locked'; row_version: number; server_doc?: unknown };
  if (result.status === 'applied') {
    return NextResponse.json({ status: 'applied', rowVersion: result.row_version, bundleHash, repriced: draft.bundleHash !== bundleHash } satisfies SyncResponse);
  }
  return NextResponse.json(
    { status: result.status, rowVersion: result.row_version, serverDoc: result.server_doc ?? null } satisfies SyncResponse,
    { status: 409 },
  );
}

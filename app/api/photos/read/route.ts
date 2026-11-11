import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isUuid, photoPath } from '@/lib/photos/rules';
import {
  CONFIDENCE_SCORE,
  impliedSqft,
  MAX_READ_PHOTO_BYTES,
  MAX_READ_PHOTOS,
  MAX_READ_TOTAL_BYTES,
  PHOTO_READ_MODEL,
  PHOTO_READ_PROMPT_VERSION,
  readContextSchema,
  READS_PER_HOUR,
} from '@/lib/ai/photoRead';
import { PhotoReadError, readPhotos, type ReadImage } from '@/lib/ai/readPhotos';

// AI photo reading. POST: read an area's photos (sent from the phone, or already on the server)
// and return findings; every read is logged to photo_analyses with its cost. PATCH: record what
// the estimator did with each suggestion (photo_corrections), for later calibration.
// Both tables are written with the service role only, after the checks here.

export const runtime = 'nodejs';
export const maxDuration = 300;

const ROLES = ['owner', 'office', 'estimator'] as const;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function fail(error: string, status: number, code = 'invalid') {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(request: NextRequest) {
  const { profile, error } = await authorize(...ROLES);
  if (error) return error;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('Expected a form upload', 400);
  }
  let ctxJson: unknown;
  try {
    ctxJson = JSON.parse(String(form.get('context') ?? ''));
  } catch {
    return fail('Missing area details', 400);
  }
  const ctx = readContextSchema.safeParse(ctxJson);
  if (!ctx.success) return fail('Area details are incomplete', 400);

  const files = form.getAll('photo').filter((f): f is File => f instanceof File);
  const localIds = form.getAll('photoId').map(String);
  const remoteIds = [...new Set(form.getAll('remotePhotoId').map(String).filter(isUuid))];
  const count = files.length + remoteIds.length;
  if (count === 0) return fail('Add a photo first', 400);
  if (count > MAX_READ_PHOTOS) return fail(`Up to ${MAX_READ_PHOTOS} photos per read`, 400);
  let total = 0;
  for (const f of files) {
    if (!IMAGE_TYPES.has(f.type)) return fail('Photos must be JPEG, PNG or WebP', 415);
    if (f.size === 0 || f.size > MAX_READ_PHOTO_BYTES) return fail('A photo is too large to read', 413);
    total += f.size;
  }
  if (total > MAX_READ_TOTAL_BYTES) return fail('The photos are too large together', 413);

  const admin = createAdminClient();
  const images: ReadImage[] = [];
  const sentIds: string[] = [];
  for (const [i, f] of files.entries()) {
    images.push({ mediaType: f.type as ReadImage['mediaType'], base64: Buffer.from(await f.arrayBuffer()).toString('base64') });
    if (isUuid(localIds[i])) sentIds.push(localIds[i]);
  }

  // Photos already on the server (taken on another phone): the user's own client checks they can
  // see them (RLS on photos). The file path is rebuilt from the ids, never taken from the row.
  // A photo deleted since the phone listed it is skipped. Order follows the phone's list, so
  // "photo 3" in the answer is the third thumbnail.
  if (remoteIds.length) {
    const supabase = await createClient();
    const { data: rows, error: rowsError } = await supabase.from('photos').select('id').in('id', remoteIds).eq('estimate_id', ctx.data.estimateId);
    if (rowsError) return fail(rowsError.message, 500, 'failed');
    const found = new Set((rows ?? []).map((r) => r.id as string));
    for (const id of remoteIds.filter((x) => found.has(x))) {
      const { data: blob, error: dlError } = await admin.storage.from('photos').download(photoPath(ctx.data.estimateId, id));
      if (dlError || !blob) continue;
      if (blob.size > MAX_READ_PHOTO_BYTES * 2) return fail('A saved photo is too large to read', 413);
      images.push({ mediaType: 'image/jpeg', base64: Buffer.from(await blob.arrayBuffer()).toString('base64') });
      sentIds.push(id);
    }
  }
  if (!images.length) return fail('Those photos are no longer available. Refresh and try again.', 404);

  // Reserve the read before calling the model, then check the hourly cap including it: reads in
  // flight and billed failures count, and parallel taps can't slip past the cap together.
  const { data: areaRow } = await admin.from('estimate_areas').select('id').eq('id', ctx.data.areaId).eq('estimate_id', ctx.data.estimateId).maybeSingle();
  const { data: reserved, error: reserveError } = await admin
    .from('photo_analyses')
    .insert({
      status: 'pending',
      area_id: (areaRow?.id as string | undefined) ?? null,
      estimate_id: ctx.data.estimateId,
      created_by: profile.userId,
      photo_ids: sentIds,
      photo_count: images.length,
      model: PHOTO_READ_MODEL,
      prompt_version: PHOTO_READ_PROMPT_VERSION,
      raw_response: {},
    })
    .select('id')
    .single();
  if (reserveError || !reserved) return fail(`Could not start the read: ${reserveError?.message ?? 'no row'}`, 500, 'failed');
  const analysisId = reserved.id as string;
  const release = () => admin.from('photo_analyses').delete().eq('id', analysisId);

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recent, error: countError } = await admin
    .from('photo_analyses')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', profile.userId)
    .gte('created_at', since);
  if (countError || (recent ?? 0) > READS_PER_HOUR) {
    await release();
    return countError ? fail(`Could not check usage: ${countError.message}`, 500, 'failed') : fail(`That's ${READS_PER_HOUR} photo reads in the last hour. Try again later.`, 429, 'busy');
  }

  let result;
  try {
    // request.signal: when the phone stops waiting (Stop, or it left), stop paying for the read.
    result = await readPhotos(images, ctx.data, request.signal);
  } catch (e) {
    const err = e instanceof PhotoReadError ? e : null;
    if (err?.usage) {
      // The model ran and was billed: keep the row (counts toward the cap and the cost record).
      await admin
        .from('photo_analyses')
        .update({ status: 'failed', error: err.code, model: err.usage.model, request_tokens: err.usage.inputTokens, response_tokens: err.usage.outputTokens, cost_usd: err.usage.costUsd })
        .eq('id', analysisId);
    } else {
      await release();
    }
    if (err) return fail(err.message, err.status, err.code);
    console.error('[photo-read] failed', e);
    return fail('The photo read failed. Try again.', 500, 'failed');
  }

  const { read } = result;
  const { error: logError } = await admin
    .from('photo_analyses')
    .update({
      status: 'done',
      model: result.model,
      request_tokens: result.inputTokens,
      response_tokens: result.outputTokens,
      cost_usd: result.costUsd,
      raw_response: read,
      est_sqft: impliedSqft(read),
      existing_material: read.existingInsulation.material,
      existing_depth_in: read.existingInsulation.depthInches,
      obstructions: read.obstructions,
      hazards: read.hazards,
      confidence: CONFIDENCE_SCORE[read.existingInsulation.confidence],
    })
    .eq('id', analysisId);
  if (logError) console.error('[photo-read] could not log the read', logError.message);

  return NextResponse.json({ read, analysisId, model: result.model, createdAt: new Date().toISOString(), photoIds: sentIds });
}

const feedbackSchema = z.object({
  analysisId: z.uuid(),
  decisions: z
    .array(
      z.object({
        field: z.string().trim().min(1).max(60),
        aiValue: z.string().max(2000).nullable(),
        confirmedValue: z.string().max(2000).nullable(),
        accepted: z.boolean(),
      }),
    )
    .min(1)
    .max(20),
});

/** PATCH {analysisId, decisions} → stores which suggestions the estimator applied or dismissed. */
export async function PATCH(request: NextRequest) {
  const { profile, error } = await authorize(...ROLES);
  if (error) return error;
  const body = feedbackSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail('Invalid feedback', 400);
  const admin = createAdminClient();
  const { data: analysis } = await admin.from('photo_analyses').select('id, created_by').eq('id', body.data.analysisId).eq('status', 'done').maybeSingle();
  if (!analysis) return fail('Unknown photo read', 404);
  if (analysis.created_by !== profile.userId && profile.role !== 'owner') return fail('Not your photo read', 403);
  const { error: insertError } = await admin.from('photo_corrections').insert(
    body.data.decisions.map((d) => ({
      analysis_id: body.data.analysisId,
      field: d.field,
      ai_value: d.aiValue,
      confirmed_value: d.confirmedValue,
      accepted: d.accepted,
      corrected_by: profile.userId,
    })),
  );
  if (insertError) return fail(insertError.message, 500, 'failed');
  return NextResponse.json({ ok: true });
}

/** GET → whether photo reading is switched on, so the app can say so before anyone waits. */
export async function GET() {
  const { error } = await authorize(...ROLES);
  if (error) return error;
  return NextResponse.json({ configured: Boolean(process.env.ANTHROPIC_API_KEY), maxPhotos: MAX_READ_PHOTOS });
}

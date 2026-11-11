import { NextResponse, type NextRequest } from 'next/server';
import { authorize } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isUuid, MAX_PHOTO_BYTES, photoPath, type RemotePhoto } from '@/lib/photos/rules';

// Area photos. The photos table's RLS (can_edit_estimate) decides who may see or change them;
// the private storage bucket has no policies, so files move through the service-role client
// only after the user's own client has passed that check. File paths are always rebuilt from
// the estimate and photo ids (photoPath), never read from photos.storage_path.

const ROLES = ['owner', 'office', 'estimator'] as const;
const SIGNED_URL_SECONDS = 60 * 60;

/** GET ?estimateId= → the estimate's photos with signed URLs. */
export async function GET(request: NextRequest) {
  const { error } = await authorize(...ROLES);
  if (error) return error;
  const estimateId = request.nextUrl.searchParams.get('estimateId');
  if (!isUuid(estimateId)) return NextResponse.json({ error: 'estimateId is required' }, { status: 400 });

  const supabase = await createClient();
  const { data: rows, error: dbError } = await supabase
    .from('photos')
    .select('id, area_id, taken_at')
    .eq('estimate_id', estimateId)
    .not('uploaded_at', 'is', null)
    .order('taken_at', { ascending: true });
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  if (!rows?.length) return NextResponse.json({ photos: [] satisfies RemotePhoto[] });

  const { data: signed, error: signError } = await createAdminClient()
    .storage.from('photos')
    .createSignedUrls(rows.map((r) => photoPath(estimateId, r.id as string)), SIGNED_URL_SECONDS);
  if (signError) return NextResponse.json({ error: signError.message }, { status: 500 });
  const urlFor = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const photos: RemotePhoto[] = rows.flatMap((r) => {
    const url = urlFor.get(photoPath(estimateId, r.id as string));
    return url ? [{ id: r.id as string, areaId: (r.area_id as string | null) ?? null, takenAt: (r.taken_at as string | null) ?? null, url }] : [];
  });
  return NextResponse.json({ photos });
}

/** POST multipart (id, estimateId, areaId, takenAt, width, height, file) → stores one photo. Idempotent by id. */
export async function POST(request: NextRequest) {
  const { profile, error } = await authorize(...ROLES);
  if (error) return error;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a form upload' }, { status: 400 });
  }
  const id = form.get('id');
  const estimateId = form.get('estimateId');
  const areaId = form.get('areaId');
  const file = form.get('file');
  if (!isUuid(id) || !isUuid(estimateId)) return NextResponse.json({ error: 'id and estimateId are required' }, { status: 400 });
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: 'No photo attached' }, { status: 400 });
  if (file.size > MAX_PHOTO_BYTES) return NextResponse.json({ error: 'Photo is too large' }, { status: 413 });
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return NextResponse.json({ error: 'Not an image' }, { status: 415 });
  const takenAt = typeof form.get('takenAt') === 'string' && !Number.isNaN(Date.parse(form.get('takenAt') as string)) ? (form.get('takenAt') as string) : null;
  const dim = (k: string) => {
    const n = Number(form.get(k));
    return Number.isInteger(n) && n > 0 && n < 20_000 ? n : null;
  };

  const supabase = await createClient();
  // The area must already be saved on the server (the phone uploads after the estimate syncs);
  // otherwise keep the photo on the estimate without an area rather than fail.
  let area: string | null = null;
  if (isUuid(areaId)) {
    const { data } = await supabase.from('estimate_areas').select('id').eq('id', areaId).eq('estimate_id', estimateId).maybeSingle();
    area = (data?.id as string | undefined) ?? null;
  }

  const path = photoPath(estimateId, id);
  // RLS gate first: this insert only succeeds for someone who can edit the estimate.
  const { error: rowError } = await supabase.from('photos').upsert(
    { id, estimate_id: estimateId, area_id: area, storage_path: path, taken_at: takenAt, width: dim('width'), height: dim('height'), created_by: profile.userId },
    { onConflict: 'id' },
  );
  if (rowError) return NextResponse.json({ error: rowError.message }, { status: rowError.code === '42501' ? 403 : 400 });

  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage.from('photos').upload(path, file, { contentType: file.type, upsert: true });
  if (uploadError) {
    await supabase.from('photos').delete().eq('id', id);
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 502 });
  }
  const { error: doneError } = await supabase.from('photos').update({ uploaded_at: new Date().toISOString() }).eq('id', id);
  if (doneError) return NextResponse.json({ error: doneError.message }, { status: 500 });
  return NextResponse.json({ ok: true, areaId: area });
}

/** DELETE ?id= → removes a photo and its file. Missing photos count as deleted. */
export async function DELETE(request: NextRequest) {
  const { error } = await authorize(...ROLES);
  if (error) return error;
  const id = request.nextUrl.searchParams.get('id');
  if (!isUuid(id)) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const supabase = await createClient();
  const { data: row, error: readError } = await supabase.from('photos').select('estimate_id').eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!row) return NextResponse.json({ ok: true });
  const { data: deleted, error: delError } = await supabase.from('photos').delete().eq('id', id).select('id');
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });
  if (!deleted?.length) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  // The file path is rebuilt from ids, never taken from the row (which a user could edit).
  await createAdminClient().storage.from('photos').remove([photoPath(row.estimate_id as string, id)]);
  return NextResponse.json({ ok: true });
}

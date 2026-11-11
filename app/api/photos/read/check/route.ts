import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env';
import { PhotoReadError, photoReadBackend, readPhotos } from '@/lib/ai/readPhotos';

// Self-check for AI photo reading: GET /api/photos/read/check?key=<CRON_SECRET> runs one real
// read of a test image (the app icon) through whichever service is set up and reports whether
// it worked, the model, time and cost. For the owner or support, not the field app; costs about
// a cent or two per call. Nothing is logged to photo_analyses.

export const runtime = 'nodejs';
export const maxDuration = 300;

function keyMatches(given: string | null, secret: string | null): boolean {
  if (!given || !secret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!keyMatches(request.nextUrl.searchParams.get('key'), serverEnv.cronSecret())) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  }
  const backend = photoReadBackend();
  if (!backend) return NextResponse.json({ ok: false, backend: null, error: 'AI photo reading is not set up.' });

  const icon = await fetch(new URL('/icons/icon-512.png', request.url));
  if (!icon.ok) return NextResponse.json({ ok: false, backend, error: `Could not load the test image (${icon.status}).` }, { status: 500 });
  const base64 = Buffer.from(await icon.arrayBuffer()).toString('base64');

  const started = Date.now();
  try {
    const r = await readPhotos([{ mediaType: 'image/png', base64 }], {
      estimateId: '00000000-0000-4000-8000-000000000000',
      areaId: '00000000-0000-4000-8000-000000000001',
      areaName: 'Self-check',
      jobType: 'attic',
      sqft: null,
      measured: false,
      currentR: null,
      existingMaterial: null,
      yearBuilt: null,
      codeR: 49,
    }, request.signal);
    return NextResponse.json({
      ok: true,
      backend,
      model: r.model,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      costUsd: r.costUsd,
      tokens: { input: r.inputTokens, output: r.outputTokens },
      // The test image is a logo, so the read should say it isn't an attic.
      matchesArea: r.read.matchesArea,
      spaceSeen: r.read.spaceSeen,
      summary: r.read.summary,
    });
  } catch (e) {
    const err = e instanceof PhotoReadError ? e : null;
    console.error('[photo-read check] failed', e);
    return NextResponse.json({ ok: false, backend, code: err?.code ?? 'failed', error: err?.message ?? String(e), seconds: Math.round((Date.now() - started) / 100) / 10 }, { status: 200 });
  }
}

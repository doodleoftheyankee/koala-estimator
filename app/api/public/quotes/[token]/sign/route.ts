// POST /api/public/quotes/:token/sign (customer): e-sign a quote.
// Stores the signature image, renders a signed PDF, records the ESIGN/UETA audit trail,
// and marks the quote and estimate signed. A conditional update makes double-submits safe.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { TIERS } from '@/lib/pricing';
import { ESIGN_CONSENT } from '@/lib/quotes/consent';
import { officeSignedNotice, sendEmail, signedConfirmationEmail } from '@/lib/quotes/email';
import { findQuoteByToken, isExpired } from '@/lib/quotes/lookup';
import { renderQuotePdf } from '@/lib/quotes/pdf';
import { sha256Hex } from '@/lib/quotes/token';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const MAX_SIGNATURE_BYTES = 300 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const bodySchema = z.object({
  tier: z.enum(TIERS),
  signerName: z.string().trim().min(2, 'Type your full name').max(100),
  signaturePng: z
    .string()
    .max(PNG_PREFIX.length + Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 4, 'Signature image is too large')
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, 'Signature must be a PNG image'),
  consent: z.literal(true, { error: 'You must agree to sign electronically' }),
});

function decodePng(dataUrl: string): Buffer | null {
  const bytes = Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64');
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) return null;
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  return bytes;
}

function conflict(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) {
    const first = body.error.issues[0];
    return NextResponse.json({ error: first?.message ?? 'Invalid request' }, { status: 400 });
  }
  const { tier, signerName, signaturePng } = body.data;
  const png = decodePng(signaturePng);
  if (!png) return NextResponse.json({ error: 'The signature image is invalid or too large. Clear it and sign again.' }, { status: 400 });

  try {
    const admin = createAdminClient();
    const quote = await findQuoteByToken(admin, token);
    if (!quote) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });

    if (quote.status === 'signed' || quote.signed_at) return conflict('This quote has already been signed.');
    if (quote.status === 'superseded') return conflict('A newer version of this quote was sent. Please use the latest link.');
    if (quote.status === 'declined') return conflict('This quote was declined. Please contact our office.');
    if (quote.status === 'expired' || isExpired(quote)) return conflict('This quote has expired. Please contact our office for an updated quote.');

    const doc = quote.document;
    const option = doc.options.find((o) => o.tier === tier);
    if (!option) return NextResponse.json({ error: 'That option is not part of this quote.' }, { status: 400 });

    const signedAt = new Date().toISOString();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null;
    const userAgent = request.headers.get('user-agent');

    const signaturePath = `${quote.id}.png`;
    const sigUpload = await admin.storage.from('signatures').upload(signaturePath, png, { contentType: 'image/png', upsert: false });
    if (sigUpload.error) {
      // Most likely a concurrent submit already stored one; report a conflict if it won.
      const again = await findQuoteByToken(admin, token);
      if (again?.signed_at) return conflict('This quote has already been signed.');
      throw new Error(`Storing the signature failed: ${sigUpload.error.message}`);
    }

    const signedPdf = await renderQuotePdf(doc, { signerName, signedAt, tier, price: option.price, imagePng: png, ip });
    const signedPdfPath = `${quote.estimate_id}/v${quote.version}-signed.pdf`;
    const pdfUpload = await admin.storage
      .from('quotes')
      .upload(signedPdfPath, signedPdf, { contentType: 'application/pdf', upsert: false });
    if (pdfUpload.error) throw new Error(`Storing the signed PDF failed: ${pdfUpload.error.message}`);

    const { data: updated, error: updErr } = await admin
      .from('quotes')
      .update({
        status: 'signed',
        signed_at: signedAt,
        signed_tier: tier,
        signed_price: option.price,
        signer_name: signerName,
        signature_path: signaturePath,
        signed_pdf_path: signedPdfPath,
        esign_audit: {
          ip,
          userAgent,
          consentText: ESIGN_CONSENT,
          documentSha256: quote.pdf_sha256,
          signedPdfSha256: sha256Hex(signedPdf),
          signatureSha256: sha256Hex(png),
          firstViewedAt: quote.first_viewed_at,
          signedAt,
        },
      })
      .eq('id', quote.id)
      .eq('status', quote.status)
      .is('signed_at', null)
      .select('id');
    if (updErr) throw new Error(`Saving the signature failed: ${updErr.message}`);
    if (!updated || updated.length === 0) return conflict('This quote has already been signed.');

    const ev = await admin
      .from('quote_events')
      .insert({ quote_id: quote.id, event: 'signed', meta: { tier, price: option.price, signer: signerName } });
    if (ev.error) console.error('[sign] recording the event failed', ev.error.message);

    const est = await admin.from('estimates').update({ status: 'signed', selected_tier: tier }).eq('id', quote.estimate_id);
    if (est.error) console.error('[sign] updating the estimate failed', est.error.message);

    // Emails are best-effort: the signature is already recorded.
    try {
      const pdfUrl = `${serverEnv.appUrl()}/api/public/quotes/${token}/pdf`;
      const jobs: Array<Promise<unknown>> = [];
      if (doc.customer.email) {
        jobs.push(
          sendEmail({
            to: doc.customer.email,
            ...signedConfirmationEmail(doc, tier, option.price, pdfUrl),
            attachments: [{ filename: `${doc.quoteNumber}-signed.pdf`, content: signedPdf }],
          }),
        );
      }
      const office = serverEnv.officeNotifyEmail();
      if (office) jobs.push(sendEmail({ to: office, ...officeSignedNotice(doc, tier, option.price, quote.estimate_id) }));
      await Promise.allSettled(jobs);
    } catch (e) {
      console.error('[sign] email failed', e instanceof Error ? e.message : e);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[sign] failed', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'We could not record your signature. Please try again or call our office.' }, { status: 500 });
  }
}

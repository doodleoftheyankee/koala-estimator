// Hard rule 1 check: renders every stored quote (scripts/accuracy/quote-docs-export.sql, read-only,
// people replaced) the way the app renders it today, so the output of two commits can be compared
// file by file. A quote already sent or signed must render exactly as before: its items, prices,
// number, dates, consent text and PDF.
//
// Usage: node scripts/accuracy/render-run.mjs scripts/accuracy/render-stored.ts <live-quote-docs.json> <out dir>
//
// For each stored quote it writes, under <out dir>/<quote id>/:
//   page-stored.*        the customer page in the quote's own state (signed, declined, expired, ...)
//   page-open-<tier>.*   the page while the quote is open, with <tier> as the recommended option,
//                        so each option's sign button and accept sentence is rendered
//   page-signed-<tier>.* the page once <tier> is signed at its price
//   page-superseded.*, page-declined.*, page-expired.*
//   pdf.txt              the quote PDF as text (pdftotext -layout), pdf-signed-<tier>.txt the signed copy
//   email-quote.*, email-signed-<tier>.*, email-office-<tier>.*  subject, text and html
// .html is the markup, .txt the text a person reads. Rendered with the real page component
// (app/q/[token]/page.tsx) and the masthead, through a stand-in for the database
// (scripts/accuracy/stubs/admin.ts), so nothing is written anywhere.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QuotePage from '@/app/q/[token]/page';
import { Masthead } from '@/app/q/[token]/parts';
import type { Tier } from '@/lib/pricing';
import { officeSignedNotice, quoteEmail, signedConfirmationEmail } from '@/lib/quotes/email';
import type { QuoteDocument } from '@/lib/quotes/model';
import { renderQuotePdf } from '@/lib/quotes/pdf';

interface StoredQuote {
  id: string;
  estimateId: string;
  version: number;
  status: string;
  expiresAt: string;
  sentAt: string | null;
  firstViewedAt: string | null;
  signedAt: string | null;
  signedTier: Tier | null;
  signedPrice: number | null;
  signerName: string | null;
  pdfSha256: string;
  hasSignedPdf: boolean;
  consentText: string | null;
  document: QuoteDocument;
}

const [inPath, outDir] = process.argv.slice(2);
if (!inPath || !outDir) throw new Error('Usage: render-stored.ts <live-quote-docs.json> <out dir>');
process.env.APP_URL = 'https://app.example.com';
const quotes = (JSON.parse(fs.readFileSync(inPath, 'utf8')) as { quotes: StoredQuote[] }).quotes;

const TOKEN = 'T'.repeat(43);
const SIGNED_AT = '2026-11-18T19:41:07.000Z';
// A 1x1 transparent PNG as the signature image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&middot;': '·', '&nbsp;': ' ' };
const plainText = (html: string) =>
  html
    .replace(/<(?:p|div|li|h[1-6]|tr|section|header|main|aside|dd|dt|table|ul|address)\b[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[#\w]+;/g, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

function write(dir: string, name: string, content: string | Buffer) {
  fs.writeFileSync(path.join(dir, name), content);
}

interface RowOverrides {
  status: string;
  expires_at?: string;
  signed_at?: string | null;
  signed_tier?: Tier | null;
  signed_price?: number | null;
  signer_name?: string | null;
}

async function renderPage(q: StoredQuote, doc: QuoteDocument, o: RowOverrides): Promise<string> {
  (globalThis as { __storedQuoteRow__?: unknown }).__storedQuoteRow__ = {
    id: q.id,
    estimate_id: q.estimateId,
    version: q.version,
    status: o.status,
    pdf_path: `${q.estimateId}/v${q.version}.pdf`,
    pdf_sha256: q.pdfSha256,
    expires_at: o.expires_at ?? q.expiresAt,
    first_viewed_at: q.firstViewedAt,
    signed_at: o.signed_at ?? null,
    signed_tier: o.signed_tier ?? null,
    signed_price: o.signed_price ?? null,
    signer_name: o.signer_name ?? null,
    signed_pdf_path: o.status === 'signed' ? `${q.estimateId}/v${q.version}-signed.pdf` : null,
    snapshot: { document: doc },
  };
  const page = (await QuotePage({ params: Promise.resolve({ token: TOKEN }) })) as ReactElement;
  return renderToStaticMarkup(createElement('div', null, createElement(Masthead, { branding: doc.branding }), page));
}

async function pdfText(buf: Buffer, file: string): Promise<string> {
  fs.writeFileSync(file, buf);
  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
  fs.unlinkSync(file);
  return text;
}

fs.mkdirSync(outDir, { recursive: true });
const started = Date.now();
let files = 0;
for (const q of quotes) {
  const dir = path.join(outDir, q.id);
  fs.mkdirSync(dir, { recursive: true });
  const doc = q.document;
  const page = async (name: string, d: QuoteDocument, o: RowOverrides) => {
    const html = await renderPage(q, d, o);
    write(dir, `page-${name}.html`, html);
    write(dir, `page-${name}.txt`, plainText(html));
    files += 2;
  };
  await page('stored', doc, {
    status: q.status,
    signed_at: q.signedAt,
    signed_tier: q.signedTier,
    signed_price: q.signedPrice,
    signer_name: q.signerName,
  });
  for (const o of doc.options) {
    await page(`open-${o.tier}`, { ...doc, recommendedTier: o.tier }, { status: 'viewed', expires_at: '2099-01-01T00:00:00.000Z' });
    await page(`signed-${o.tier}`, doc, { status: 'signed', signed_at: SIGNED_AT, signed_tier: o.tier, signed_price: o.price, signer_name: 'Signer' });
  }
  await page('superseded', doc, { status: 'superseded' });
  await page('declined', doc, { status: 'declined' });
  await page('expired', doc, { status: 'expired' });

  write(dir, 'pdf.txt', await pdfText(await renderQuotePdf(doc), path.join(dir, 'tmp.pdf')));
  files++;
  for (const o of doc.options) {
    const signed = await renderQuotePdf(doc, { signerName: 'Signer', signedAt: SIGNED_AT, tier: o.tier, price: o.price, imagePng: PNG, ip: '203.0.113.7' });
    write(dir, `pdf-signed-${o.tier}.txt`, await pdfText(signed, path.join(dir, 'tmp.pdf')));
    files++;
  }

  const mail = (name: string, t: { subject: string; text: string; html: string }) => {
    write(dir, `email-${name}.txt`, `Subject: ${t.subject}\n\n${t.text}\n`);
    write(dir, `email-${name}.html`, t.html);
    files += 2;
  };
  mail('quote', quoteEmail(doc, `https://app.example.com/q/${TOKEN}`));
  for (const o of doc.options) {
    mail(`signed-${o.tier}`, signedConfirmationEmail(doc, o.tier, o.price, `https://app.example.com/api/public/quotes/${TOKEN}/pdf`));
    mail(`office-${o.tier}`, officeSignedNotice(doc, o.tier, o.price, q.estimateId));
  }
}
console.log(`Rendered ${quotes.length} stored quotes into ${files} files in ${outDir} (${((Date.now() - started) / 1000).toFixed(1)} s).`);

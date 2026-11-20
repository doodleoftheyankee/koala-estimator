// Hard rule 1 check, documents only: render-stored.ts without the customer page, so it also runs on
// code whose page component it cannot render (origin/main, the live site). Renders every stored
// quote's PDFs (as text) and emails (subject, text and HTML) from the read-only export
// (scripts/accuracy/quote-docs-export.sql), the way the code it runs in renders them, so two commits
// can be compared file by file. Nothing is written anywhere but <out dir>.
//
// Usage: node scripts/accuracy/render-run.mjs scripts/accuracy/render-docs-only.ts <live-quote-docs.json> <out dir>
//   (on another commit: git archive it, copy render-run.mjs, stubs/ and this file into its
//   scripts/accuracy/, link node_modules, and run the same command there)
//
// For each stored quote it writes, under <out dir>/<quote id>/: pdf.txt, pdf-signed-<tier>.txt,
// email-quote.*, email-signed-<tier>.*, email-office-<tier>.* (the same names as render-stored.ts).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

function write(dir: string, name: string, content: string | Buffer) {
  fs.writeFileSync(path.join(dir, name), content);
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

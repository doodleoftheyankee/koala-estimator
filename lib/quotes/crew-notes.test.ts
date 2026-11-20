// The estimator's "Notes for the crew" (EstimateDraft.crewNotes, the load list) are for the crew
// only: a quote built from a draft that has them never carries them, so the customer's quote page,
// its PDF (sent and signed) and every email built from it never show them. "Notes for the quote"
// still print, which also shows the checks below read the text they mean to.
import { inflateSync } from 'node:zlib';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { priceEstimate } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { newArea, newDraft, toEstimateInput } from '@/lib/sync/draft';
import { NotesCard, QuoteIntro } from '@/app/q/[token]/parts';
import { officeSignedNotice, quoteEmail, signedConfirmationEmail } from './email';
import { buildQuoteDocument, type QuoteDocument } from './model';
import { renderQuotePdf } from './pdf';

vi.mock('server-only', () => ({}));

const CREW_NOTES = 'CREWONLY gate code 4411, dog in the yard, bring the 28 ft ladder';
const QUOTE_NOTES = 'Customer asked about the garage too';

function quoteFromDraftWithCrewNotes(): QuoteDocument {
  const d = newDraft(new Date('2026-11-20T12:00:00Z'), undefined, { city: 'Springfield', state: 'IL' });
  d.customer = { ...d.customer, firstName: 'Robin', lastName: 'Vale', email: 'robin@example.com' };
  d.property = { ...d.property, street: '9 Elm Ct', zip: '62701' };
  d.areas = [{ ...newArea('attic'), sqft: 1000, currentR: 19 }];
  d.notes = QUOTE_NOTES;
  d.crewNotes = CREW_NOTES;
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  return buildQuoteDocument({
    draft: d,
    options: priced.options,
    version: 1,
    quoteNumber: 'AA-2026-0001-v1',
    issuedAt: new Date('2026-11-20T12:00:00Z'),
    validDays: 30,
    branding: { company: 'Acme Attics', license: null, phone: null, email: null, website: null, primaryColor: '#7c3aed', logoUrl: null },
    estimator: { name: 'Sam Rivera', email: 'sam@acme.example' },
    terms: 'Terms as the franchise wrote them.',
    warranty: 'Warranty as the franchise wrote it.',
    consent: 'I agree to sign this quote electronically.',
  });
}

/** The PDF's text: each content stream inflated, its text runs decoded and joined. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    let body: string;
    try {
      body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const r of body.matchAll(/\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
      out.push([...(r[1] ?? `<${r[2]}>`).matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join(''));
    }
    re.lastIndex = end;
  }
  return out.join('');
}

const html = (el: ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe("notes for the crew never reach the customer (load list)", () => {
  const doc = quoteFromDraftWithCrewNotes();

  it('the quote document (what the page, the PDF and the emails are built from) does not carry them', () => {
    const json = JSON.stringify(doc);
    expect(json).toContain(QUOTE_NOTES);
    expect(json).not.toContain('CREWONLY');
    expect(json).not.toContain('crewNotes');
  });

  it("the customer's quote page does not show them", () => {
    const page = html(createElement('main', null, createElement(QuoteIntro, { doc }), doc.notes ? createElement(NotesCard, { notes: doc.notes }) : null));
    expect(page).toContain(QUOTE_NOTES);
    expect(page).not.toContain('CREWONLY');
  });

  it('the PDF, sent and signed, does not show them', async () => {
    const sent = pdfText(await renderQuotePdf(doc));
    expect(sent).toContain('garage too');
    expect(sent).not.toContain('CREWONLY');
    const better = doc.options.find((o) => o.tier === 'better')!;
    const signed = pdfText(
      await renderQuotePdf(doc, {
        signerName: 'Robin Vale',
        signedAt: '2026-11-20T19:41:07.000Z',
        tier: 'better',
        price: better.price,
        imagePng: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
        ip: '203.0.113.7',
      }),
    );
    expect(signed).toContain('Robin Vale');
    expect(signed).not.toContain('CREWONLY');
  });

  it('no email built from the quote shows them', () => {
    const better = doc.options.find((o) => o.tier === 'better')!;
    const mails = [
      quoteEmail(doc, 'https://app.example.com/q/token'),
      signedConfirmationEmail(doc, 'better', better.price, 'https://app.example.com/pdf'),
      officeSignedNotice(doc, 'better', better.price, '00000000-0000-4000-8000-000000000001'),
    ];
    for (const mail of mails) {
      expect(`${mail.subject}\n${mail.text}\n${mail.html}`).not.toContain('CREWONLY');
    }
  });
});

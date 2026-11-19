import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { newArea, newDraft, toEstimateInput } from '@/lib/sync/draft';
import { escapeHtml, financingLine, officeSignedNotice, quoteEmail, signedConfirmationEmail } from './email';
import { esignConsent } from './consent';
import { buildQuoteDocument, DEFAULT_BRAND_COLOR, quoteMoney, type QuoteDocument } from './model';
import { quoteSettingsFromRows } from './settings';

const EVIL = '<script>alert("x")</script>';

function makeDoc(firstName = 'Pat') {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), undefined, { city: 'Springfield', state: 'IL' });
  d.customer = { ...d.customer, firstName, lastName: 'Lee & Sons', email: 'pat@example.com' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic'), sqft: 1000 }];
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  return buildQuoteDocument({
    draft: d,
    options: priced.options,
    version: 1,
    quoteNumber: 'Q-2026-0001-v1',
    issuedAt: new Date('2026-10-20T12:00:00Z'),
    validDays: 30,
    branding: { company: 'Koala', license: 'DE-123', phone: '302-555-0100', email: null, website: null, primaryColor: DEFAULT_BRAND_COLOR, logoUrl: null },
    estimator: { name: 'Sam', email: 'sam@example.com' },
    terms: 'T',
    warranty: 'W',
    consent: esignConsent('IL'),
  });
}

/** The same document as one sent before the accuracy round (no format): it prints as it did then. */
const sentBefore = (doc: QuoteDocument): QuoteDocument => {
  const copy: Partial<QuoteDocument> = { ...doc };
  delete copy.format;
  delete copy.consent;
  return copy as QuoteDocument;
};

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
  });
  it('leaves plain text alone', () => {
    expect(escapeHtml('Pat Lee 123')).toBe('Pat Lee 123');
  });
});

describe('quote email templates', () => {
  const url = 'https://estimator.example.com/q/abc_DEF-123';

  it('quoteEmail includes the link, quote number and every option price', () => {
    const doc = makeDoc();
    const t = quoteEmail(doc, url);
    expect(t.subject).toContain(doc.quoteNumber);
    expect(t.html).toContain(`href="${url}"`);
    expect(t.text).toContain(url);
    for (const o of doc.options) {
      expect(t.html).toContain(quoteMoney(o.price));
      expect(t.text).toContain(quoteMoney(o.price));
    }
  });

  it('escapes a malicious customer name in every template', () => {
    const doc = makeDoc(EVIL);
    const tier = doc.options[0]!.tier;
    const price = doc.options[0]!.price;
    for (const t of [quoteEmail(doc, url), signedConfirmationEmail(doc, tier, price), officeSignedNotice(doc, tier, price, doc.quoteNumber)]) {
      expect(t.html).not.toContain('<script>');
      expect(t.html).toContain('&lt;script&gt;');
    }
    expect(officeSignedNotice(doc, tier, price, 'x').html).toContain('Lee &amp; Sons');
  });

  it('never puts a non-http URL into an href', () => {
    const t = quoteEmail(makeDoc(), 'javascript:alert(1)');
    expect(t.html).not.toContain('href="javascript:');
  });

  it('signed confirmation includes the price in whole dollars, the option and the PDF link (L8)', () => {
    const doc = makeDoc();
    const o = doc.options.find((x) => x.tier === 'better')!;
    const t = signedConfirmationEmail(doc, 'better', o.price, 'https://x.example/pdf');
    expect(t.html).toContain(`Price: <strong>${quoteMoney(o.price)}</strong>`);
    expect(t.html).toContain(escapeHtml(o.label));
    expect(t.html).toContain('https://x.example/pdf');
    expect(t.text).toContain(`Price: ${quoteMoney(o.price)}\n`);
    expect(t.text).not.toMatch(/\$[\d,]+\.\d\d/);
  });

  it('a quote sent before the accuracy round confirms its signed price to the cent, as it did (hard rule 1)', () => {
    const doc = sentBefore(makeDoc());
    const o = doc.options.find((x) => x.tier === 'better')!;
    const t = signedConfirmationEmail(doc, 'better', o.price, 'https://x.example/pdf');
    expect(t.text).toContain(`Price: ${quoteMoney(o.price)}.00`);
    expect(officeSignedNotice(doc, 'good', 1234.5, 'x').text).toContain('Price: $1,234.50');
  });

  it('office notice links to the estimate and shows the price, the same in the subject and the body (L8)', () => {
    const doc = makeDoc();
    const t = officeSignedNotice(doc, 'good', 4780, '0b6f2d1e-0000-4000-8000-000000000000');
    expect(t.html).toContain('/field?e=0b6f2d1e-0000-4000-8000-000000000000');
    expect(t.subject).toContain('- $4,780 (');
    expect(t.text).toContain('Price: $4,780\n');
    expect(t.html).toContain('Price: <strong>$4,780</strong>');
  });
});

describe('financingLine', () => {
  it('formats monthly, term and APR with and without a provider', () => {
    expect(financingLine({ provider: null, apr: 0.0999, termMonths: 120, monthly: 41.2 })).toBe(
      'As low as $42/mo for 120 months at 9.99% APR, subject to credit approval.',
    );
    expect(financingLine({ provider: 'GreenSky', apr: 0.0999, termMonths: 120, monthly: 41.2 })).toContain('Financing through GreenSky');
  });
});

describe('quoteSettingsFromRows', () => {
  it('falls back to defaults', () => {
    const s = quoteSettingsFromRows([]);
    // OD12: the brand, no franchise town (was 'Koala Insulation of Newark').
    expect(s.branding.company).toBe('Koala Insulation');
    expect(s.branding.primaryColor).toBe(DEFAULT_BRAND_COLOR);
    expect(s.validDays).toBe(30);
    expect(s.terms.length).toBeGreaterThan(10);
  });
  it('reads branding, terms and validity', () => {
    const s = quoteSettingsFromRows([
      { key: 'branding', value: { company: 'K', license: 'L1', phone: '1', primary_color: '#123456', logo_path: 'logo.png' } },
      { key: 'quote_terms', value: 'Terms here' },
      { key: 'warranty_text', value: 'Warranty here' },
      { key: 'quote_valid_days', value: 14 },
    ]);
    expect(s.branding).toMatchObject({ company: 'K', license: 'L1', phone: '1', primaryColor: '#123456', logoUrl: null, email: null });
    expect(s).toMatchObject({ terms: 'Terms here', warranty: 'Warranty here', validDays: 14 });
  });
  it('ignores an invalid color', () => {
    expect(quoteSettingsFromRows([{ key: 'branding', value: { primary_color: 'red;}' } }]).branding.primaryColor).toBe(DEFAULT_BRAND_COLOR);
  });
});

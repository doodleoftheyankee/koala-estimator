import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { newArea, newDraft, toEstimateInput } from '@/lib/sync/draft';
import { escapeHtml, financingLine, officeSignedNotice, quoteEmail, signedConfirmationEmail } from './email';
import { buildQuoteDocument, DEFAULT_BRAND_COLOR, formatUsd } from './model';
import { quoteSettingsFromRows } from './settings';

const EVIL = '<script>alert("x")</script>';

function makeDoc(firstName = 'Pat') {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'));
  d.customer = { ...d.customer, firstName, lastName: 'Lee & Sons', email: 'pat@example.com' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic'), sqft: 1000 }];
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  return buildQuoteDocument({
    draft: d,
    options: priced.options,
    version: 1,
    issuedAt: new Date('2026-10-20T12:00:00Z'),
    validDays: 30,
    branding: { company: 'Koala', license: 'DE-123', phone: '302-555-0100', email: null, website: null, primaryColor: DEFAULT_BRAND_COLOR, logoUrl: null },
    estimator: { name: 'Sam', email: 'sam@example.com' },
    terms: 'T',
    warranty: 'W',
  });
}

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
      expect(t.html).toContain(formatUsd(o.price));
      expect(t.text).toContain(formatUsd(o.price));
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

  it('signed confirmation includes the price, option and PDF link', () => {
    const doc = makeDoc();
    const o = doc.options.find((x) => x.tier === 'better')!;
    const t = signedConfirmationEmail(doc, 'better', o.price, 'https://x.example/pdf');
    expect(t.html).toContain(formatUsd(o.price, true));
    expect(t.html).toContain(escapeHtml(o.label));
    expect(t.html).toContain('https://x.example/pdf');
    expect(t.text).toContain(formatUsd(o.price, true));
  });

  it('office notice links to the estimate and shows the price', () => {
    const doc = makeDoc();
    const t = officeSignedNotice(doc, 'good', 1234.5, '0b6f2d1e-0000-4000-8000-000000000000');
    expect(t.html).toContain('/field?e=0b6f2d1e-0000-4000-8000-000000000000');
    expect(t.text).toContain('$1,234.50');
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
    expect(s.branding.company).toBe('Koala Insulation of Newark');
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

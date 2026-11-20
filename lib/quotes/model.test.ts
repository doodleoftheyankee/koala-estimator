import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { newArea, newDraft, toEstimateInput } from '@/lib/sync/draft';
import { esignConsent } from './consent';
import { buildQuoteDocument, DEFAULT_BRAND_COLOR, DOCUMENT_FORMAT, quoteMoney, sentenceMoney } from './model';
import { hashQuoteToken, isWellFormedToken, newQuoteToken } from './token';

describe('quote document', () => {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), undefined, { city: 'Springfield', state: 'IL' });
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  // Old insulation in place (R-19), so Best removes it and all three options step up (OD6).
  d.areas = [{ ...newArea('attic'), sqft: 1000, currentR: 19 }];
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  const docArgs = () => ({
    draft: d,
    options: priced.options,
    version: 2,
    quoteNumber: 'Q-2026-0007-v2',
    issuedAt: new Date('2026-10-20T12:00:00Z'),
    validDays: 30,
    branding: { company: 'Koala', license: null, phone: null, email: null, website: null, primaryColor: DEFAULT_BRAND_COLOR, logoUrl: null },
    estimator: { name: 'Sam', email: null },
    terms: 'T',
    warranty: 'W',
    consent: esignConsent('IL'),
  });
  const doc = buildQuoteDocument(docArgs());

  it('carries options and customer items but never costs', () => {
    expect(doc.options.map((o) => o.tier)).toEqual(['good', 'better', 'best']);
    const json = JSON.stringify(doc);
    for (const secret of ['loadedCost', 'directCost', 'marginPct', 'costPerUnit', 'unitCost']) expect(json).not.toContain(secret);
  });

  it('carries each line with its kind; the lines add up to the option price (L1, L4)', () => {
    for (const o of doc.options) {
      expect(o.items.reduce((a, i) => a + i.price, 0)).toBe(o.price);
      expect(o.items.filter((i) => i.kind === 'work').every((i) => i.areaName === 'Attic')).toBe(true);
      expect(o.items.filter((i) => i.kind !== 'work')).toEqual([expect.objectContaining({ kind: 'travel', areaName: '', description: 'Travel and setup' })]);
    }
  });

  it('never recommends an option the quote does not carry (OD6)', () => {
    const r0 = { ...d, areas: [{ ...d.areas[0]!, currentR: 0 }], selectedTier: 'best' as const }; // Best repeats Better here
    const shown = priceEstimate(toEstimateInput(r0), snapshot, coefficients).options;
    expect(shown.map((o) => o.tier)).toEqual(['good', 'better']);
    const picked = buildQuoteDocument({ ...docArgs(), draft: r0, options: shown });
    expect(picked.recommendedTier).toBe('better'); // before: 'best', an option not on the quote
    expect(buildQuoteDocument({ ...docArgs(), draft: { ...r0, selectedTier: 'good' }, options: shown }).recommendedTier).toBe('good');
  });

  it('computes validity, number and recommended tier', () => {
    expect(doc.validUntil).toBe('2026-11-19');
    expect(doc.quoteNumber).toBe('Q-2026-0007-v2');
    expect(doc.recommendedTier).toBe('better');
    expect(doc.customer.name).toBe('Pat Lee');
    expect(doc.property.line2).toBe('Springfield, IL 19711');
    expect(doc.format).toBe(DOCUMENT_FORMAT);
    expect(doc.consent).toContain('(ESIGN Act and Illinois UETA)');
  });

  it('formats dollars: whole dollars on a quote; cents in sentences only on a quote sent before (L8)', () => {
    expect(quoteMoney(5420)).toBe('$5,420');
    expect(quoteMoney(12.5)).toBe('$13');
    expect(sentenceMoney(doc, 4780)).toBe('$4,780');
    expect(sentenceMoney({}, 4780)).toBe('$4,780.00');
    expect(sentenceMoney({}, 12.5)).toBe('$12.50');
  });
});

describe('quote tokens', () => {
  it('are 256-bit, well formed, and hashed', () => {
    const { token, hash } = newQuoteToken();
    expect(isWellFormedToken(token)).toBe(true);
    expect(hash).toBe(hashQuoteToken(token));
    expect(hash).toHaveLength(64);
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken(`${token.slice(0, 42)}!`)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { newArea, newDraft, toEstimateInput } from '@/lib/sync/draft';
import { buildQuoteDocument, DEFAULT_BRAND_COLOR, formatUsd, quoteNumber } from './model';
import { hashQuoteToken, isWellFormedToken, newQuoteToken } from './token';

describe('quote document', () => {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'));
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic'), sqft: 1000 }];
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  const doc = buildQuoteDocument({
    draft: d,
    options: priced.options,
    version: 2,
    issuedAt: new Date('2026-10-20T12:00:00Z'),
    validDays: 30,
    branding: { company: 'Koala', license: null, phone: null, email: null, website: null, primaryColor: DEFAULT_BRAND_COLOR, logoUrl: null },
    estimator: { name: 'Sam', email: null },
    terms: 'T',
    warranty: 'W',
  });

  it('carries options and customer items but never costs', () => {
    expect(doc.options.map((o) => o.tier)).toEqual(['good', 'better', 'best']);
    const json = JSON.stringify(doc);
    for (const secret of ['loadedCost', 'directCost', 'marginPct', 'costPerUnit', 'unitCost']) expect(json).not.toContain(secret);
  });

  it('computes validity, number and recommended tier', () => {
    expect(doc.validUntil).toBe('2026-11-19');
    expect(doc.quoteNumber).toBe(quoteNumber(d.id, 2, new Date('2026-10-20T12:00:00Z')));
    expect(doc.quoteNumber).toMatch(/^KN-2026-[0-9A-F]{6}-v2$/);
    expect(doc.recommendedTier).toBe('better');
    expect(doc.customer.name).toBe('Pat Lee');
    expect(doc.property.line2).toBe('Newark, DE 19711');
  });

  it('formats dollars', () => {
    expect(formatUsd(5420)).toBe('$5,420');
    expect(formatUsd(12.5, true)).toBe('$12.50');
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

import { describe, expect, it } from 'vitest';
import { priceEstimate, type PricedOption } from '@/lib/pricing';
import { seededArea as area, seededBundle, seededEstimate as estimate } from '@/lib/pricing/__fixtures__/seeded';
import { headlinePrice } from '@/lib/office/estimates';
import { buildQuoteDocument } from '@/lib/quotes/model';
import { newArea, newDraft } from '@/lib/sync/draft';
import { buildSyncPayload } from '@/lib/sync/payload';
import { recommendedTier } from './recommended';

const opts = [{ tier: 'good' }, { tier: 'better' }, { tier: 'best' }] as const;

describe('recommendedTier', () => {
  it('is the option the estimator picked', () => {
    expect(recommendedTier(opts, 'best')).toEqual({ tier: 'best', picked: true });
  });

  it('with no pick (or a pick that is no tier), Better, and says it is the default', () => {
    expect(recommendedTier(opts, null)).toEqual({ tier: 'better', picked: false });
    expect(recommendedTier(opts, 'gone')).toEqual({ tier: 'better', picked: false });
  });

  it('is nothing when there are no options', () => {
    expect(recommendedTier([], 'better')).toBeNull();
  });
});

describe('OD15 (review B flow-B4): with no pick, Better is the implied pick', () => {
  it('Better not shown, Good and Best shown: Best, as when Better is picked (was Good, the cheapest)', () => {
    expect(recommendedTier([{ tier: 'good' }, { tier: 'best' }], null)).toEqual({ tier: 'best', picked: false });
    expect(recommendedTier([{ tier: 'good' }, { tier: 'best' }], 'better')).toEqual({ tier: 'best', picked: false });
  });

  it('Better not shown and nothing shown above it: the nearest below', () => {
    expect(recommendedTier([{ tier: 'good' }], null)).toEqual({ tier: 'good', picked: false });
    expect(recommendedTier([{ tier: 'good' }], 'better')).toEqual({ tier: 'good', picked: false });
  });

  it('a pick that is not shown moves first to the option shown that does the same work', () => {
    // Better hidden because Good does the same work for less: Good, not the next one up.
    const goodDoesBetter = [{ tier: 'good', sameWorkAs: ['better'] }, { tier: 'best' }] as const;
    expect(recommendedTier(goodDoesBetter, null)).toEqual({ tier: 'good', picked: false });
    expect(recommendedTier(goodDoesBetter, 'better')).toEqual({ tier: 'good', picked: false });
    // Picked Good, hidden because Best does the same work for less: Best, not Better.
    expect(recommendedTier([{ tier: 'better' }, { tier: 'best', sameWorkAs: ['good'] }], 'good')).toEqual({ tier: 'best', picked: false });
  });

  // The review's case: the seeded attic of 1,386 sq ft at R-0, where Best is the same work as
  // Better. The estimator raises Better to $7,538, above Best ($6,070), so Better is not shown.
  const input = estimate({ areas: [area({ sqft: 1386, currentR: 0 })], overrides: { better: { price: 7538, reason: 'Two-story access' } } });
  const priced = priceEstimate(input, seededBundle.snapshot, seededBundle.coefficientSet);
  const byTier = (t: string) => priced.options.find((o) => o.tier === t) as PricedOption;

  it('the engine says which option shown does the work of the hidden Better', () => {
    expect(priced.options.map((o) => `${o.tier} ${o.price}`)).toEqual(['good 4195', 'best 6070']);
    expect(byTier('best').sameWorkAs).toEqual(['better']);
    expect(byTier('good').sameWorkAs).toBeUndefined();
  });

  it('the phone, the office list, the sync and the quote all recommend Best at $6,070 (was Good at $4,195)', () => {
    expect(recommendedTier(priced.options, null)).toEqual({ tier: 'best', picked: false });
    // Picked or not, the same option.
    expect(recommendedTier(priced.options, 'better')).toEqual({ tier: 'best', picked: false });
    // The office list reads the stored options (tier and price only).
    const stored = priced.options.map((o) => ({ tier: o.tier, price: o.price }));
    expect(headlinePrice({ selectedTier: null, options: stored, modelTotalPrice: null, signedPrice: null })).toEqual({ price: 6070, tier: 'best', signed: false });

    const d = newDraft(new Date('2026-11-19T12:00:00Z'), undefined, { city: 'Springfield', state: 'IL' });
    d.areas = [{ ...newArea('attic'), sqft: 1386, currentR: 0 }];
    d.overrides = input.overrides;
    const payload = buildSyncPayload(d, priced, seededBundle, { pricedOffline: false });
    expect(payload.estimate.selected_tier).toBeNull();
    expect(payload.estimate.model_total_price).toBe(byTier('best').modelPrice);

    const doc = buildQuoteDocument({
      draft: d,
      options: priced.options,
      version: 1,
      quoteNumber: 'AA-2026-0001-v1',
      issuedAt: new Date('2026-11-19T12:00:00Z'),
      validDays: 30,
      branding: { company: 'Acme Attics', license: null, phone: null, email: null, website: null, primaryColor: '#7c3aed', logoUrl: null },
      estimator: { name: 'Sam Rivera', email: null },
      terms: 'T',
      warranty: 'W',
      consent: 'C',
    } as unknown as Parameters<typeof buildQuoteDocument>[0]);
    expect(doc.recommendedTier).toBe('best');
  });
});

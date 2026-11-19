import { describe, expect, it } from 'vitest';
import { parseWith } from './forms';
import { costOutsideRange, crewForm, rangeWithConfirmedCost, materialForm, materialRangeForm, newCrewForm, parseTierForm, productForm, codeRequirementForm, PRIMARY_PRODUCTS } from './pricingForms';

const ID = '8f14e45f-ceea-467f-a8f6-3b3a0c6c2b10';
const ID2 = '1f14e45f-ceea-467f-a8f6-3b3a0c6c2b11';

describe('row forms', () => {
  it('material: blank coverage is null, negative cost rejected', () => {
    expect(parseWith(materialForm, { id: ID, name: 'Cellulose bag', cost_per_unit: '14.50', coverage_sqft_in: '' })).toEqual({
      ok: true,
      data: { id: ID, name: 'Cellulose bag', cost_per_unit: 14.5, coverage_sqft_in: null },
    });
    const bad = parseWith(materialForm, { id: ID, name: 'x', cost_per_unit: '-1' });
    expect(bad.ok).toBe(false);
  });

  it('crew: size is a whole number 1..10; active from toggle', () => {
    expect(parseWith(crewForm, { id: ID, name: 'Crew A', size: '2', blended_hourly_cost: '38', active: 'true' })).toEqual({
      ok: true,
      data: { id: ID, name: 'Crew A', size: 2, blended_hourly_cost: 38, active: true },
    });
    expect(parseWith(newCrewForm, { name: 'B', size: '11', blended_hourly_cost: '30' }).ok).toBe(false);
    expect(parseWith(newCrewForm, { name: '', size: '2', blended_hourly_cost: '30' }).ok).toBe(false);
  });

  it('product: blank R per inch is null', () => {
    expect(parseWith(productForm, { id: ID, label: 'Air Sealing', r_per_inch: '', active: 'true' })).toEqual({
      ok: true,
      data: { id: ID, label: 'Air Sealing', r_per_inch: null, active: true },
    });
  });

  it('code requirement', () => {
    const r = parseWith(codeRequirementForm, { id: ID, min_r: '49', alt_spec: '', code_edition: '2018 IECC', source_note: 'Newark permit office' });
    expect(r).toEqual({ ok: true, data: { id: ID, min_r: 49, alt_spec: null, code_edition: '2018 IECC', source_note: 'Newark permit office' } });
    expect(parseWith(codeRequirementForm, { id: ID, min_r: '0', code_edition: 'x' }).ok).toBe(false);
  });
});

describe('parseTierForm', () => {
  it('splits a job type form into tier rows', () => {
    const r = parseTierForm({
      job_type: 'attic',
      'good.id': ID,
      'good.label': 'Blown Fiberglass',
      'good.primary_product': 'fiberglass_blown',
      'good.target_r': '',
      'good.include_air_sealing': 'false',
      'good.include_removal': 'false',
      'good.marketing_bullets': 'One\n\nTwo',
      'good.active': 'true',
      'best.id': ID2,
      'best.label': 'Cellulose',
      'best.primary_product': 'cellulose',
      'best.target_r': '60',
      'best.include_air_sealing': 'true',
      'best.include_removal': 'true',
      'best.marketing_bullets': '',
      'best.active': 'false',
    });
    expect(r).toEqual({
      ok: true,
      jobType: 'attic',
      rows: [
        { tier: 'good', id: ID, label: 'Blown Fiberglass', primary_product: 'fiberglass_blown', target_r: null, include_air_sealing: false, include_removal: false, marketing_bullets: ['One', 'Two'], active: true },
        { tier: 'best', id: ID2, label: 'Cellulose', primary_product: 'cellulose', target_r: 60, include_air_sealing: true, include_removal: true, marketing_bullets: [], active: false },
      ],
    });
  });

  it('rejects non-R-bearing primary products and bad job types', () => {
    expect(PRIMARY_PRODUCTS).not.toContain('removal');
    const r = parseTierForm({ job_type: 'attic', 'good.id': ID, 'good.label': 'X', 'good.primary_product': 'removal' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Good: /);
    expect(parseTierForm({ job_type: 'roof' }).ok).toBe(false);
    expect(parseTierForm({ job_type: 'attic' })).toEqual({ ok: false, error: 'Nothing to save.' });
  });
});

describe('material cost ranges (L11, RF-13)', () => {
  const range = { min: 0.06, max: 0.24, source: 'Starting range: half to twice the cost on file when ranges were added. Enter your supplier\'s range.' };

  it('a cost 100 times the usual is caught, with the range and its source', () => {
    // Open-cell foam is about $0.12 a board foot; $12 is a price per something else.
    // Measured from the nearest edge of the range (review B flow-B9), not its middle ($0.15).
    expect(costOutsideRange(12, range, 'board ft')).toBe(
      "$12 per board ft is 50 times the usual high of $0.24. The usual range is $0.06 to $0.24 (Starting range: half to twice the cost on file when ranges were added. Enter your supplier's range.). Check the unit, or tick “This cost is right” to save it.",
    );
    expect(costOutsideRange(15.25, range, 'board ft')).toMatch(/^\$15\.25 per board ft is 64 times the usual high of \$0\.24\. The usual range is \$0\.06 to \$0\.24 /);
    expect(costOutsideRange(0.01, range, 'board ft')).toMatch(/^\$0\.01 per board ft is 6\.0 times less than the usual low of \$0\.06\. The usual range is \$0\.06 to \$0\.24 /);
  });

  it('says how far a cost is from the nearest edge: a percentage, "N times" only from twice the edge (review B flow-B9)', () => {
    // Before: "$0.30 per board ft is 2.0 times more than the usual $0.06 to $0.24" (against the middle).
    expect(costOutsideRange(0.3, range, 'board ft')).toMatch(/^\$0\.30 per board ft is 25% above the usual high of \$0\.24\. /);
    // Before: "$0.05 ... is 3.0 times less than the usual".
    expect(costOutsideRange(0.05, range, 'board ft')).toMatch(/^\$0\.05 per board ft is 17% below the usual low of \$0\.06\. /);
    expect(costOutsideRange(0.47, range, 'board ft')).toMatch(/ is 96% above the usual high of \$0\.24\. /);
    expect(costOutsideRange(0.48, range, 'board ft')).toMatch(/ is 2\.0 times the usual high of \$0\.24\. /);
    expect(costOutsideRange(0.03, range, 'board ft')).toMatch(/ is 2\.0 times less than the usual low of \$0\.06\. /);
    expect(costOutsideRange(0.2401, range, 'board ft')).toMatch(/ is just above the usual high of \$0\.24\. /);
  });

  it('a cost the owner confirmed widens the stored range to it, so the next save is not refused again (review B flow-B9)', () => {
    // Before: the range stayed $0.06 to $0.24, so every later save of $0.30 was refused until ticked again.
    const after = rangeWithConfirmedCost(range, 0.3, true);
    expect(after).toEqual({ ...range, min: 0.06, max: 0.3 });
    expect(costOutsideRange(0.3, after, 'board ft')).toBeNull();
    expect(rangeWithConfirmedCost(range, 0.05, true)).toEqual({ ...range, min: 0.05, max: 0.24 });
    // Not confirmed, inside the range, or no range: the range as it was.
    expect(rangeWithConfirmedCost(range, 0.3, false)).toEqual(range);
    expect(rangeWithConfirmedCost(range, 0.12, true)).toEqual(range);
    const none = { min: null, max: null, source: null };
    expect(rangeWithConfirmedCost(none, 0.3, true)).toEqual(none);
  });

  it('a cost inside the range, or a material with no range, is fine', () => {
    for (const c of [0.06, 0.12, 0.24]) expect(costOutsideRange(c, range, 'board ft')).toBeNull();
    expect(costOutsideRange(500, { min: null, max: null, source: null }, 'bag')).toBeNull();
    expect(costOutsideRange(0, range, 'board ft')).toMatch(/^\$0 per board ft is far below the usual/);
  });

  it('the range fields and the confirmation are read from the form', () => {
    expect(parseWith(materialRangeForm, { typical_min: '0.06', typical_max: '0.24', typical_source: 'Supplier list', cost_confirmed: 'true' })).toEqual({
      ok: true,
      data: { typical_min: 0.06, typical_max: 0.24, typical_source: 'Supplier list', cost_confirmed: true },
    });
    expect(parseWith(materialRangeForm, {})).toEqual({ ok: true, data: { typical_min: null, typical_max: null, typical_source: null, cost_confirmed: false } });
    const backwards = parseWith(materialRangeForm, { typical_min: '2', typical_max: '1' });
    expect(backwards).toEqual({ ok: false, error: 'The usual low cost must not be above the usual high cost.' });
  });
});

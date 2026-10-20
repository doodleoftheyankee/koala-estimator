import { describe, expect, it } from 'vitest';
import { parseWith } from './forms';
import { crewForm, materialForm, newCrewForm, parseTierForm, productForm, codeRequirementForm, PRIMARY_PRODUCTS } from './pricingForms';

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

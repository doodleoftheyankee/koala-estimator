import { describe, expect, it } from 'vitest';
import {
  crossCheckSettings,
  displayValue,
  marginPreview,
  objectFieldText,
  parseSettingsForm,
  SETTING_GROUPS,
  settingBool,
  settingObject,
  toSettingsMap,
  type ScalarSetting,
} from './settings';

const CREW = '8f14e45f-ceea-467f-a8f6-3b3a0c6c2b10';

describe('parseSettingsForm: the load list (Pricing, "Always bring")', () => {
  it('saves one item per line as load_list.always_bring, on its own card', () => {
    expect(parseSettingsForm({ 'load_list.always_bring': 'Ladders\r\n\nTarps and drop cloths\n' })).toEqual({
      ok: true,
      values: { load_list: { always_bring: ['Ladders', 'Tarps and drop cloths'] } },
    });
    expect(parseSettingsForm({ 'load_list.always_bring': '' })).toEqual({ ok: true, values: { load_list: { always_bring: [] } } });
  });
  it('refuses an item too long to read on a phone', () => {
    const r = parseSettingsForm({ 'load_list.always_bring': 'x'.repeat(200) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^Always bring: keep each item under 120 characters/);
  });
});

describe('parseSettingsForm', () => {
  it('stores percentages as fractions and numbers as numbers', () => {
    const r = parseSettingsForm({
      overhead_pct: '18',
      target_margin_pct: '40',
      floor_margin_pct: '25',
      ceiling_margin_pct: '60',
      estimator_override_limit_pct: '10',
      deviation_threshold: '15',
      minimum_job_price: '995',
      price_rounding: '5',
      productive_hours_per_day: '7',
      vehicle_cost_per_trip: '45',
      disposal_cost_per_sqft: '0.35',
      quote_valid_days: '30',
      estimators_see_costs: 'false',
      default_crew_id: CREW,
      shop_address: ' 1 Main St, Newark, DE ',
    });
    expect(r).toEqual({
      ok: true,
      values: {
        overhead_pct: 0.18,
        target_margin_pct: 0.4,
        floor_margin_pct: 0.25,
        ceiling_margin_pct: 0.6,
        estimator_override_limit_pct: 0.1,
        deviation_threshold: 0.15,
        minimum_job_price: 995,
        price_rounding: 5,
        productive_hours_per_day: 7,
        vehicle_cost_per_trip: 45,
        disposal_cost_per_sqft: 0.35,
        quote_valid_days: 30,
        estimators_see_costs: false,
        default_crew_id: CREW,
        shop_address: '1 Main St, Newark, DE',
      },
    });
  });

  it('only returns keys present in the form', () => {
    const r = parseSettingsForm({ estimators_see_costs: 'true', unrelated: 'x' });
    expect(r).toEqual({ ok: true, values: { estimators_see_costs: true } });
  });

  it('rejects out-of-range values with readable errors', () => {
    const r = parseSettingsForm({ target_margin_pct: '95', overhead_pct: '-1', quote_valid_days: '2.5' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Target net margin must be less than 95');
      expect(r.error).toContain('Overhead must be at least 0');
      expect(r.error).toContain('Quote valid days must be a whole number');
    }
  });

  it('rejects an empty form', () => {
    expect(parseSettingsForm({})).toEqual({ ok: false, error: 'Nothing to save.' });
  });

  it('parses financing as an object', () => {
    const r = parseSettingsForm({
      'financing.provider': 'GreenSky',
      'financing.apr': '9.99',
      'financing.term_months': '120',
      'financing.show': 'true',
    });
    expect(r).toEqual({ ok: true, values: { financing: { provider: 'GreenSky', apr: 0.0999, term_months: 120, show: true } } });
    const blank = parseSettingsForm({ 'financing.provider': '', 'financing.apr': '0', 'financing.term_months': '12', 'financing.show': 'false' });
    expect(blank).toEqual({ ok: true, values: { financing: { provider: null, apr: 0, term_months: 12, show: false } } });
    expect(parseSettingsForm({ 'financing.apr': '100', 'financing.term_months': '12' }).ok).toBe(false);
  });

  it('parses branding and validates email and color', () => {
    const r = parseSettingsForm({
      'branding.company': 'Koala Insulation of Newark',
      'branding.license': '',
      'branding.phone': '302-555-0100',
      'branding.email': 'newark@example.com',
      'branding.website': '',
      'branding.primary_color': '#0f766e',
    });
    expect(r).toEqual({
      ok: true,
      values: {
        branding: {
          company: 'Koala Insulation of Newark',
          license: null,
          phone: '302-555-0100',
          email: 'newark@example.com',
          website: null,
          primary_color: '#0f766e',
        },
      },
    });
    const bad = parseSettingsForm({ 'branding.company': 'K', 'branding.email': 'nope', 'branding.primary_color': 'teal' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain('valid email');
      expect(bad.error).toContain('#0f766e');
    }
  });

  it('requires a valid crew id and non-empty texts', () => {
    expect(parseSettingsForm({ default_crew_id: 'x' }).ok).toBe(false);
    expect(parseSettingsForm({ quote_terms: '  ' }).ok).toBe(false);
    expect(parseSettingsForm({ warranty_text: 'Lifetime workmanship' })).toEqual({ ok: true, values: { warranty_text: 'Lifetime workmanship' } });
  });
});

describe('crossCheckSettings', () => {
  it('requires floor <= target <= ceiling', () => {
    expect(crossCheckSettings({ floor_margin_pct: 0.25, target_margin_pct: 0.4, ceiling_margin_pct: 0.6 })).toBeNull();
    expect(crossCheckSettings({ target_margin_pct: 0.5, ceiling_margin_pct: 0.4 })).toMatch(/Ceiling/);
    expect(crossCheckSettings({ floor_margin_pct: 0.5, target_margin_pct: 0.4 })).toMatch(/Floor/);
    expect(crossCheckSettings({})).toBeNull();
  });
});

describe('display helpers', () => {
  const map = toSettingsMap([
    { key: 'overhead_pct', value: 0.18 },
    { key: 'minimum_job_price', value: '995' },
    { key: 'financing', value: { provider: null, apr: 0.0999, term_months: 120, show: true } },
    { key: 'estimators_see_costs', value: false },
  ]);
  const setting = (key: string): ScalarSetting => {
    const s = SETTING_GROUPS.flatMap((g) => g.settings).find((x) => x.key === key);
    if (!s) throw new Error(key);
    return s;
  };

  it('shows percentages for percent settings', () => {
    expect(displayValue(map, setting('overhead_pct'))).toBe('18');
    expect(displayValue(map, setting('minimum_job_price'))).toBe('995');
    expect(displayValue(map, setting('target_margin_pct'))).toBe('');
  });

  it('reads booleans and objects', () => {
    expect(settingBool(map, 'estimators_see_costs')).toBe(false);
    expect(settingBool({ x: true }, 'x')).toBe(true);
    const fin = settingObject(map, 'financing');
    expect(objectFieldText(fin, 'provider')).toBe('');
    expect(objectFieldText(fin, 'term_months')).toBe('120');
    expect(settingObject(map, 'missing')).toEqual({});
    expect(settingObject({ a: [1] }, 'a')).toEqual({});
  });
});

describe('Target net margin (L10, OD9, S2-F10, RF-14)', () => {
  const setting = (key: string): ScalarSetting => SETTING_GROUPS.flatMap((g) => g.settings).find((x) => x.key === key)!;

  it('is labelled net, after overhead, and previews the gross margin', () => {
    // The engine prices direct cost x (1 + overhead) / (1 - margin): the margin is net of overhead.
    expect(setting('target_margin_pct').label).toBe('Target net margin (after overhead)');
    expect(setting('target_margin_pct').hint).not.toMatch(/gross/i);
    expect(setting('floor_margin_pct').hint).toMatch(/after overhead/);
    expect(setting('ceiling_margin_pct').hint).toMatch(/after overhead/);
    const p = marginPreview(0.63, 0.15)!;
    expect(p.multiple).toBeCloseTo(1.9176, 4);
    expect(p.grossMarginPct).toBeCloseTo(0.4785, 4);
    expect(p.text).toBe('With 63% overhead, a 15% net margin is about a 48% gross margin: prices are 1.92 times the direct job cost.');
    // The trap the audit found: typing the usual 48% gross margin here overprices by about 63%.
    const typedGross = marginPreview(0.63, 0.48)!;
    expect(typedGross.multiple / p.multiple).toBeCloseTo(1.63, 2);
    expect(marginPreview(0.63, 0.95)).toBeNull();
    expect(marginPreview(Number.NaN, 0.15)).toBeNull();
  });

  it('the stored value is unchanged: 15 on the page is 0.15 in the database, as before', () => {
    const r = parseSettingsForm({ target_margin_pct: '15' });
    expect(r).toEqual({ ok: true, values: { target_margin_pct: 0.15 } });
    expect(displayValue({ target_margin_pct: 0.15 }, setting('target_margin_pct'))).toBe('15');
  });
});

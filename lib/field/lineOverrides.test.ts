import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineKey, priceEstimate, type PricedLine } from '@/lib/pricing';
import { area, coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { draftSchema, newArea, newDraft, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import {
  applyLineOverride,
  buildLineOverride,
  formatAmount,
  formatPctDiff,
  lineMetric,
  lineView,
  relativeDiff,
  removeLineOverride,
  tiersWithLine,
  unitLabel,
} from './lineOverrides';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function draftWithAttic(): EstimateDraft {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), uuid);
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic', uuid), sqft: 1000, accessLevel: 'easy' }];
  d.driveMinutesOneWay = 20;
  return d;
}

const price = (d: EstimateDraft) => priceEstimate(toEstimateInput(d), snapshot, coefficients);

const line = (overrides: Partial<PricedLine> = {}): PricedLine => ({
  key: 'a1|cellulose|material',
  areaId: 'a1',
  kind: 'material',
  product: 'cellulose',
  materialId: 'm-cel',
  description: 'Cellulose bag',
  qty: 80,
  unit: 'bag',
  hours: null,
  unitCost: 14,
  cost: 1120,
  designQty: 74,
  modelQty: 80,
  modelHours: null,
  modelCost: 1120,
  isOverridden: false,
  overrideReason: null,
  ...overrides,
});

describe('lineMetric', () => {
  it('material lines take a quantity, labor and removal lines take hours', () => {
    expect(lineMetric({ key: 'k', kind: 'material' })).toBe('qty');
    expect(lineMetric({ key: 'k', kind: 'labor' })).toBe('hours');
    expect(lineMetric({ key: 'k', kind: 'removal' })).toBe('hours');
  });

  it('job-level lines and lines without a key are not editable', () => {
    for (const kind of ['drive', 'disposal', 'misc', 'discount'] as const) expect(lineMetric({ key: 'k', kind })).toBeNull();
    expect(lineMetric({ key: null, kind: 'material' })).toBeNull();
    expect(lineMetric({ key: null, kind: 'labor' })).toBeNull();
  });
});

describe('lineView', () => {
  it('shows the model value for an untouched material line', () => {
    expect(lineView(line())).toEqual({
      key: 'a1|cellulose|material',
      metric: 'qty',
      unit: 'bag',
      modelValue: 80,
      value: 80,
      pctDiff: 0,
      isOverridden: false,
      reason: null,
    });
  });

  it('shows model vs the estimator value and the difference for an overridden labor line', () => {
    const v = lineView(
      line({ key: 'a1|cellulose|labor', kind: 'labor', unit: 'hour', qty: 15, hours: 15, modelQty: null, modelHours: 12, isOverridden: true, overrideReason: 'Low clearance' }),
    );
    expect(v).toMatchObject({ metric: 'hours', unit: 'hour', modelValue: 12, value: 15, isOverridden: true, reason: 'Low clearance' });
    expect(v!.pctDiff).toBeCloseTo(0.25, 10);
  });

  it('is null for lines that cannot be overridden or have no model value', () => {
    expect(lineView(line({ key: null, kind: 'drive' }))).toBeNull();
    expect(lineView(line({ modelQty: null }))).toBeNull();
    expect(lineView(line({ kind: 'labor', hours: null, modelHours: 3 }))).toBeNull();
    expect(lineView(line({ qty: Number.NaN }))).toBeNull();
  });

  it('has no percentage when the model value is zero', () => {
    expect(lineView(line({ modelQty: 0, qty: 5, isOverridden: true, overrideReason: 'x' }))!.pctDiff).toBeNull();
  });

  it('reads every line the engine produces: keyed area lines are editable, drive and disposal are not', () => {
    const d = draftWithAttic();
    d.areas[0]!.removalNeeded = true;
    for (const o of price(d).options) {
      for (const l of o.lines) {
        if (l.kind === 'drive' || l.kind === 'disposal') expect(lineView(l)).toBeNull();
        else expect(lineView(l)).toMatchObject({ key: l.key, isOverridden: false, pctDiff: 0 });
      }
    }
  });
});

describe('relativeDiff', () => {
  it('is signed and relative to the model', () => {
    expect(relativeDiff(120, 100)).toBeCloseTo(0.2, 10);
    expect(relativeDiff(80, 100)).toBeCloseTo(-0.2, 10);
    expect(relativeDiff(100, 100)).toBe(0);
  });

  it('is null instead of dividing by zero or carrying NaN', () => {
    expect(relativeDiff(5, 0)).toBeNull();
    expect(relativeDiff(5, -1)).toBeNull();
    expect(relativeDiff(Number.NaN, 10)).toBeNull();
    expect(relativeDiff(5, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('buildLineOverride', () => {
  it('builds a qty override for material lines and an hours override for labor lines, trimming the reason', () => {
    expect(buildLineOverride('qty', 70, '  Deep joist bays ')).toEqual({ ok: true, override: { qty: 70, reason: 'Deep joist bays' } });
    expect(buildLineOverride('hours', 15.5, 'Low clearance')).toEqual({ ok: true, override: { hours: 15.5, reason: 'Low clearance' } });
    expect(buildLineOverride('hours', 0, 'Customer does it')).toEqual({ ok: true, override: { hours: 0, reason: 'Customer does it' } });
  });

  it('needs a number', () => {
    expect(buildLineOverride('qty', null, 'reason')).toEqual({ ok: false, error: 'Enter a quantity.' });
    expect(buildLineOverride('hours', null, 'reason')).toEqual({ ok: false, error: 'Enter the person-hours.' });
    expect(buildLineOverride('hours', Number.NaN, 'reason')).toMatchObject({ ok: false });
    expect(buildLineOverride('qty', -1, 'reason')).toEqual({ ok: false, error: 'The number cannot be negative.' });
  });

  it('needs a reason of at least 3 characters', () => {
    expect(buildLineOverride('qty', 70, '')).toEqual({ ok: false, error: 'Give a reason (at least 3 characters).' });
    expect(buildLineOverride('qty', 70, '  ab  ')).toEqual({ ok: false, error: 'Give a reason (at least 3 characters).' });
    expect(buildLineOverride('qty', 70, 'x'.repeat(501))).toEqual({ ok: false, error: 'Keep the reason under 500 characters.' });
  });

  it('rejects numbers the sync schema would reject', () => {
    expect(buildLineOverride('qty', 1_000_001, 'reason')).toEqual({ ok: false, error: 'That number is too large.' });
    expect(buildLineOverride('hours', 10_001, 'reason')).toEqual({ ok: false, error: 'That number is too large.' });
    expect(buildLineOverride('hours', 10_000, 'reason').ok).toBe(true);
  });

  it('anything it accepts keeps the draft valid for sync (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom('qty' as const, 'hours' as const), fc.double({ noNaN: true }), fc.string({ maxLength: 600 }), (metric, value, reason) => {
        const built = buildLineOverride(metric, value, reason);
        if (!built.ok) return;
        const d = applyLineOverride(draftWithAttic(), 'a|b|c', built.override);
        expect(draftSchema.safeParse(d).success).toBe(true);
      }),
    );
  });
});

describe('applyLineOverride / removeLineOverride', () => {
  it('sets the override without touching the original draft', () => {
    const d = draftWithAttic();
    const next = applyLineOverride(d, 'k1', { hours: 15, reason: 'Low clearance' });
    expect(next.lineOverrides).toEqual({ k1: { hours: 15, reason: 'Low clearance' } });
    expect(d.lineOverrides).toEqual({});
    expect(next).not.toBe(d);
  });

  it('replaces an existing override for the same key and keeps the others', () => {
    let d = applyLineOverride(draftWithAttic(), 'k1', { hours: 15, reason: 'one' });
    d = applyLineOverride(d, 'k2', { qty: 3, reason: 'two' });
    d = applyLineOverride(d, 'k1', { hours: 9, reason: 'three' });
    expect(d.lineOverrides).toEqual({ k1: { hours: 9, reason: 'three' }, k2: { qty: 3, reason: 'two' } });
  });

  it('removes only that key; removing a missing key is a no-op', () => {
    const d = applyLineOverride(applyLineOverride(draftWithAttic(), 'k1', { hours: 1, reason: 'one' }), 'k2', { qty: 2, reason: 'two' });
    const removed = removeLineOverride(d, 'k1');
    expect(removed.lineOverrides).toEqual({ k2: { qty: 2, reason: 'two' } });
    expect(d.lineOverrides).toHaveProperty('k1');
    expect(removeLineOverride(removed, 'k1')).toBe(removed);
    expect(removeLineOverride(removed, 'toString')).toBe(removed);
  });

  it('works on drafts saved before Phase 2 (no lineOverrides field)', () => {
    const legacy = { ...draftWithAttic(), lineOverrides: undefined } as unknown as EstimateDraft;
    expect(removeLineOverride(legacy, 'k1')).toBe(legacy);
    expect(applyLineOverride(legacy, 'k1', { qty: 2, reason: 'two' }).lineOverrides).toEqual({ k1: { qty: 2, reason: 'two' } });
  });

  it('an override applies to every tier with that line and "use model value" restores the model price', () => {
    const d = draftWithAttic();
    const key = lineKey(d.areas[0]!.id, 'cellulose', 'labor');
    const before = price(d);
    const tiers = tiersWithLine(before.options, key);
    expect(tiers).toEqual(['better', 'best']);

    const changed = price(applyLineOverride(d, key, { hours: 30, reason: 'Tight attic' }));
    for (const t of tiers) {
      const o = changed.options.find((x) => x.tier === t)!;
      expect(lineView(o.lines.find((l) => l.key === key)!)).toMatchObject({ value: 30, isOverridden: true, reason: 'Tight attic' });
      expect(o.hasLineOverrides).toBe(true);
    }
    expect(changed.options.find((o) => o.tier === 'good')!.hasLineOverrides).toBe(false);

    const restored = price(removeLineOverride(applyLineOverride(d, key, { hours: 30, reason: 'Tight attic' }), key));
    expect(restored).toEqual(before);
  });
});

describe('tiersWithLine', () => {
  it('lists the tiers in option order and nothing for an unknown key', () => {
    const d = draftWithAttic();
    const options = price(d).options;
    const fg = lineKey(d.areas[0]!.id, 'fiberglass_blown', 'material');
    expect(tiersWithLine(options, fg)).toEqual(['good']);
    expect(tiersWithLine(options, 'nope')).toEqual([]);
    expect(tiersWithLine([], fg)).toEqual([]);
  });

  it('works with the fixture area id too', () => {
    const r = priceEstimate({ areas: [area({ removalNeeded: true })], crewId: null, driveMinutesOneWay: 10, overrides: {} }, snapshot, coefficients);
    expect(tiersWithLine(r.options, lineKey('a1', 'removal', 'removal'))).toEqual(['good', 'better', 'best']);
  });
});

describe('formatting', () => {
  it('formats amounts with singular and plural units', () => {
    expect(formatAmount(58, 'bag')).toBe('58 bags');
    expect(formatAmount(1, 'bag')).toBe('1 bag');
    expect(formatAmount(1200, 'board_ft')).toBe('1,200 board ft');
    expect(formatAmount(10.456, 'hour')).toBe('10.46 h');
    expect(formatAmount(2, 'each')).toBe('2 units');
    expect(formatAmount(1, 'linear_ft')).toBe('1 linear ft');
    expect(formatAmount(3.5, null)).toBe('3.5');
    expect(formatAmount(900, 'sqft')).toBe('900 sq ft');
  });

  it('labels units for form fields', () => {
    expect(unitLabel('bag')).toBe('bags');
    expect(unitLabel('hour')).toBe('h');
    expect(unitLabel(null)).toBe('units');
  });

  it('formats signed percentages like the deviation messages', () => {
    expect(formatPctDiff(0.207)).toBe('+21%');
    expect(formatPctDiff(0.151)).toBe('+15.1%');
    expect(formatPctDiff(-0.13)).toBe('−13%');
    expect(formatPctDiff(-0.5)).toBe('−50%');
    expect(formatPctDiff(0)).toBe('0%');
    expect(formatPctDiff(0.00001)).toBe('0%');
    expect(formatPctDiff(12.345)).toBe('+1,235%');
    expect(formatPctDiff(null)).toBe('—');
    expect(formatPctDiff(Number.NaN)).toBe('—');
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeDeviationFlags } from '@/lib/learning/deviation';
import type { DeviationFlag } from '@/lib/learning/types';
import { lineKey, priceEstimate, type PricingBundle } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { draftSchema, newArea, newDraft, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import {
  ACK_MAX_LENGTH,
  ackNote,
  ackSummary,
  flagsForOption,
  isAcknowledged,
  parseFlagList,
  setDeviationAck,
  unacknowledgedFlags,
} from './flags';
import { applyLineOverride } from './lineOverrides';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const bundle: PricingBundle = { hash: 'abc', builtAt: '2026-10-20T00:00:00.000Z', snapshot, coefficientSet: coefficients, winModel: null };

function draftWithAttic(): EstimateDraft {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), uuid);
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic', uuid), sqft: 1000, accessLevel: 'easy' }];
  d.driveMinutesOneWay = 20;
  return d;
}

/** Exactly what the editor does: flags for the draft as priced on the phone. */
function flagsOf(d: EstimateDraft) {
  const input = { ...toEstimateInput(d), areas: priceableAreas(d) };
  const priced = priceEstimate(input, snapshot, coefficients);
  return { priced, flags: computeDeviationFlags(priced, input, bundle) };
}

const flag = (o: Partial<DeviationFlag> = {}): DeviationFlag => ({
  key: 'better|total_price',
  tier: 'better',
  lineKey: null,
  metric: 'total_price',
  estimatorValue: 120,
  modelValue: 100,
  pctDiff: 0.2,
  reasons: [],
  message: 'Better option price 20% above model.',
  ...o,
});

describe('ackNote / isAcknowledged', () => {
  it('reads own keys only', () => {
    expect(ackNote({ k: 'note' }, 'k')).toBe('note');
    expect(ackNote({ k: 'note' }, 'other')).toBe('');
    expect(ackNote(undefined, 'k')).toBe('');
    expect(ackNote({}, 'constructor')).toBe('');
    expect(ackNote({}, 'toString')).toBe('');
    expect(ackNote({ k: 5 } as unknown as Record<string, string>, 'k')).toBe('');
  });

  it('a whitespace-only note does not count (the server trims too)', () => {
    expect(isAcknowledged({ key: 'k' }, { k: 'Deep bays' })).toBe(true);
    expect(isAcknowledged({ key: 'k' }, { k: '   \n ' })).toBe(false);
    expect(isAcknowledged({ key: 'k' }, { k: '' })).toBe(false);
    expect(isAcknowledged({ key: 'k' }, {})).toBe(false);
  });
});

describe('ackSummary / unacknowledgedFlags', () => {
  it('nothing to explain when there are no flags', () => {
    expect(ackSummary([], {})).toEqual({ total: 0, acknowledged: 0, pending: 0, allExplained: true });
  });

  it('counts explained and pending flags; unknown ack keys are ignored', () => {
    const flags = [flag({ key: 'a' }), flag({ key: 'b' }), flag({ key: 'c' })];
    const acks = { a: 'ok', b: ' ', stale: 'old note' };
    expect(ackSummary(flags, acks)).toEqual({ total: 3, acknowledged: 1, pending: 2, allExplained: false });
    expect(unacknowledgedFlags(flags, acks).map((f) => f.key)).toEqual(['b', 'c']);
    expect(ackSummary(flags, { a: 'x', b: 'y', c: 'z' }).allExplained).toBe(true);
  });

  it('matches the server rule: send is allowed exactly when every flag has a trimmed note (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 6 }),
        fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 6 })),
        (keys, acks) => {
          const flags = keys.map((key) => flag({ key }));
          const serverBlocks = flags.filter((f) => !(Object.hasOwn(acks, f.key) ? acks[f.key] : undefined)?.trim()).length > 0;
          expect(ackSummary(flags, acks).allExplained).toBe(!serverBlocks);
        },
      ),
    );
  });
});

describe('setDeviationAck', () => {
  it('stores, replaces and (with an empty note) removes a note without mutating the draft', () => {
    const d = draftWithAttic();
    const a = setDeviationAck(d, 'k', 'Deep bays');
    expect(a.deviationAcks).toEqual({ k: 'Deep bays' });
    expect(d.deviationAcks).toEqual({});
    const b = setDeviationAck(a, 'k', 'Deep bays, wet');
    expect(b.deviationAcks).toEqual({ k: 'Deep bays, wet' });
    expect(setDeviationAck(b, 'k', '').deviationAcks).toEqual({});
    expect(b.deviationAcks).toEqual({ k: 'Deep bays, wet' });
  });

  it('works on drafts saved before Phase 2 (no deviationAcks field)', () => {
    const legacy = { ...draftWithAttic(), deviationAcks: undefined } as unknown as EstimateDraft;
    expect(setDeviationAck(legacy, 'k', 'note').deviationAcks).toEqual({ k: 'note' });
    expect(setDeviationAck(legacy, 'k', '').deviationAcks).toEqual({});
    expect(ackSummary([flag({ key: 'k' })], legacy.deviationAcks)).toMatchObject({ pending: 1, allExplained: false });
  });

  it('keeps whitespace while typing but caps the length so the draft stays syncable', () => {
    const d = draftWithAttic();
    expect(setDeviationAck(d, 'k', 'Deep ').deviationAcks.k).toBe('Deep ');
    const long = setDeviationAck(d, 'k', 'x'.repeat(ACK_MAX_LENGTH + 50));
    expect(long.deviationAcks.k).toHaveLength(ACK_MAX_LENGTH);
    expect(draftSchema.safeParse(long).success).toBe(true);
  });
});

describe('flagsForOption', () => {
  it('shows a line flag on every option with the line, and a total flag only on its own tier', () => {
    const d = draftWithAttic();
    const key = lineKey(d.areas[0]!.id, 'cellulose', 'labor');
    const { priced, flags } = flagsOf(applyLineOverride(d, key, { hours: 40, reason: 'Very tight attic' }));

    const lineFlag = flags.find((f) => f.lineKey === key);
    expect(lineFlag).toBeDefined();
    expect(flags.filter((f) => f.lineKey === key)).toHaveLength(1); // deduplicated across tiers

    const byTier = Object.fromEntries(priced.options.map((o) => [o.tier, flagsForOption(flags, o)]));
    expect(byTier.good!.all).toEqual([]);
    for (const t of ['better', 'best'] as const) {
      const of = byTier[t]!;
      expect(of.byLine.get(key)).toEqual([lineFlag]);
      expect(of.total.map((f) => f.key)).toEqual(flags.filter((f) => f.lineKey === null && f.tier === t).map((f) => f.key));
      expect(of.all).toContain(lineFlag);
      expect(of.all).toHaveLength(of.total.length + 1);
    }
  });

  it('a price override far from the model raises a total flag on that tier only', () => {
    const d = draftWithAttic();
    d.overrides = { good: { price: 99_999, reason: 'test' } };
    const { priced, flags } = flagsOf(d);
    const good = flagsForOption(flags, priced.options.find((o) => o.tier === 'good')!);
    expect(good.total.map((f) => f.key)).toEqual(['good|total_price']);
    expect(good.byLine.size).toBe(0);
    const better = flagsForOption(flags, priced.options.find((o) => o.tier === 'better')!);
    expect(better.all).toEqual([]);
  });

  it('groups several flags on one line and ignores lines the option does not have', () => {
    const option = { tier: 'good' as const, lines: [{ key: 'x' }, { key: null }] as Array<{ key: string | null }> };
    const flags = [flag({ key: 'x|qty', lineKey: 'x', metric: 'qty' }), flag({ key: 'x|hours', lineKey: 'x', metric: 'hours' }), flag({ key: 'y|qty', lineKey: 'y' })];
    const of = flagsForOption(flags, option as Parameters<typeof flagsForOption>[1]);
    expect(of.byLine.get('x')!.map((f) => f.key)).toEqual(['x|qty', 'x|hours']);
    expect(of.byLine.has('y')).toBe(false);
    expect(of.all.map((f) => f.key)).toEqual(['x|qty', 'x|hours']);
  });

  it('an acknowledged line flag stays acknowledged in every tier (one note per key)', () => {
    const d = draftWithAttic();
    const key = lineKey(d.areas[0]!.id, 'cellulose', 'labor');
    const withOverride = applyLineOverride(d, key, { hours: 40, reason: 'Very tight attic' });
    const { flags } = flagsOf(withOverride);
    const acked = flags.reduce((acc, f) => setDeviationAck(acc, f.key, 'Crawl-only attic, measured'), withOverride);
    expect(ackSummary(flagsOf(acked).flags, acked.deviationAcks).allExplained).toBe(true);
  });
});

describe('parseFlagList', () => {
  it('reduces the 409 body to key + message, dropping duplicates', () => {
    expect(
      parseFlagList([
        { ...flag({ key: 'a', message: 'A' }), ackNote: null },
        { key: 'b', message: 'B', extra: 1 },
        { key: 'a', message: 'A again' },
      ]),
    ).toEqual([
      { key: 'a', message: 'A' },
      { key: 'b', message: 'B' },
    ]);
  });

  it('anything malformed is an empty list', () => {
    expect(parseFlagList(undefined)).toEqual([]);
    expect(parseFlagList(null)).toEqual([]);
    expect(parseFlagList('flags')).toEqual([]);
    expect(parseFlagList([{ key: 1, message: 'x' }])).toEqual([]);
    expect(parseFlagList([])).toEqual([]);
  });
});

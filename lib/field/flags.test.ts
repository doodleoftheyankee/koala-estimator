import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeDeviationFlags } from '@/lib/learning/deviation';
import type { DeviationFlag } from '@/lib/learning/types';
import { lineKey, priceEstimate, type PricingBundle } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { draftSchema, newArea, newDraft, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import {
  ACK_MAX_LENGTH,
  ACK_PCT_TOLERANCE,
  ackMatchesDeviation,
  ackNote,
  ackState,
  ackSummary,
  acknowledgedNote,
  clearDeviationAcks,
  flagsForOption,
  isAcknowledged,
  lineFlagKeys,
  parseFlagList,
  readAck,
  setDeviationAck,
  totalFlagKey,
  unacknowledgedFlags,
} from './flags';
import { applyLineOverride, removeLineOverride, setPriceOverride } from './lineOverrides';

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

/** A saved acknowledgement: the note and the deviation it was written for. */
const ack = (note: string, pctDiff: number | null = 0.2) => ({ note, pctDiff });

describe('readAck / ackNote / isAcknowledged', () => {
  it('reads own keys only, in the current and the earlier (bare string) form', () => {
    expect(ackNote({ k: ack('note') }, 'k')).toBe('note');
    expect(ackNote({ k: 'note' }, 'k')).toBe('note');
    expect(ackNote({ k: ack('note') }, 'other')).toBe('');
    expect(ackNote(undefined, 'k')).toBe('');
    expect(ackNote({}, 'constructor')).toBe('');
    expect(ackNote({}, 'toString')).toBe('');
    expect(ackNote({ k: 5 }, 'k')).toBe('');
    expect(ackNote({ k: { note: 5, pctDiff: 0.2 } }, 'k')).toBe('');
    expect(readAck({ k: ack('note', -0.3) }, 'k')).toEqual({ note: 'note', pctDiff: -0.3 });
    expect(readAck({ k: 'note' }, 'k')).toEqual({ note: 'note', pctDiff: null });
    expect(readAck({ k: { note: 'note', pctDiff: Number.NaN } }, 'k')).toEqual({ note: 'note', pctDiff: null });
    expect(readAck({ k: null }, 'k')).toBeNull();
  });

  it('a whitespace-only note does not count (the server trims too)', () => {
    const f = { key: 'k', pctDiff: 0.2 };
    expect(isAcknowledged(f, { k: ack('Deep bays') })).toBe(true);
    expect(isAcknowledged(f, { k: ack('   \n ') })).toBe(false);
    expect(isAcknowledged(f, { k: ack('') })).toBe(false);
    expect(isAcknowledged(f, {})).toBe(false);
    expect(ackState(f, { k: ack('  ') })).toEqual({ status: 'missing', note: '  ', ackedPctDiff: 0.2 });
    expect(ackState(f, undefined)).toEqual({ status: 'missing', note: '', ackedPctDiff: null });
  });

  it('the note stored with a flag is trimmed, and only there while it explains the flag', () => {
    const f = { key: 'k', pctDiff: 0.2 };
    expect(acknowledgedNote(f, { k: ack('  Deep bays \n') })).toBe('Deep bays');
    expect(acknowledgedNote(f, { k: ack('Deep bays', 0.5) })).toBeNull();
    expect(acknowledgedNote(f, { k: ack(' ') })).toBeNull();
    expect(acknowledgedNote(f, {})).toBeNull();
  });
});

describe('ackSummary / unacknowledgedFlags', () => {
  it('nothing to explain when there are no flags', () => {
    expect(ackSummary([], {})).toEqual({ total: 0, acknowledged: 0, pending: 0, allExplained: true });
  });

  it('counts explained and pending flags; unknown ack keys are ignored', () => {
    const flags = [flag({ key: 'a' }), flag({ key: 'b' }), flag({ key: 'c' })];
    const acks = { a: ack('ok'), b: ack(' '), stale: ack('old note') };
    expect(ackSummary(flags, acks)).toEqual({ total: 3, acknowledged: 1, pending: 2, allExplained: false });
    expect(unacknowledgedFlags(flags, acks).map((f) => f.key)).toEqual(['b', 'c']);
    expect(ackSummary(flags, { a: ack('x'), b: ack('y'), c: ack('z') }).allExplained).toBe(true);
  });

  it('a note counts only for the deviation it was written for, give or take ACK_PCT_TOLERANCE (property)', () => {
    // Deviations as the flags carry them: 4 decimals, beyond the 15% threshold, either direction.
    const bp = fc.integer({ min: 1500, max: 30000 });
    fc.assert(
      fc.property(bp, fc.boolean(), fc.integer({ min: -600, max: 600 }), (size, up, moveBp) => {
        const sign = up ? 1 : -1;
        const written = (sign * size) / 10000;
        const now = (sign * size + moveBp) / 10000;
        const acks = setDeviationAck(draftWithAttic(), flag({ key: 'k', pctDiff: written }), 'Low clearance').deviationAcks;
        const state = ackState(flag({ key: 'k', pctDiff: now }), acks);
        const within = Math.abs(moveBp) <= ACK_PCT_TOLERANCE * 10000;
        expect(state.status).toBe(within ? 'explained' : 'stale');
        expect(state.note).toBe('Low clearance');
        expect(ackSummary([flag({ key: 'k', pctDiff: now })], acks).allExplained).toBe(within);
      }),
    );
  });
});

describe('setDeviationAck', () => {
  const f = flag({ key: 'k', pctDiff: 0.31 });

  it('stores the note with the deviation, replaces it and (with an empty note) removes it, without mutating the draft', () => {
    const d = draftWithAttic();
    const a = setDeviationAck(d, f, 'Deep bays');
    expect(a.deviationAcks).toEqual({ k: { note: 'Deep bays', pctDiff: 0.31 } });
    expect(d.deviationAcks).toEqual({});
    const b = setDeviationAck(a, { key: 'k', pctDiff: 0.32 }, 'Deep bays, wet');
    expect(b.deviationAcks).toEqual({ k: { note: 'Deep bays, wet', pctDiff: 0.32 } });
    expect(setDeviationAck(b, f, '').deviationAcks).toEqual({});
    expect(b.deviationAcks).toEqual({ k: { note: 'Deep bays, wet', pctDiff: 0.32 } });
  });

  it('works on drafts saved before Phase 2 (no deviationAcks field)', () => {
    const legacy = { ...draftWithAttic(), deviationAcks: undefined } as unknown as EstimateDraft;
    expect(setDeviationAck(legacy, f, 'note').deviationAcks).toEqual({ k: { note: 'note', pctDiff: 0.31 } });
    expect(setDeviationAck(legacy, f, '').deviationAcks).toEqual({});
    expect(ackSummary([f], legacy.deviationAcks)).toMatchObject({ pending: 1, allExplained: false });
    expect(clearDeviationAcks(legacy, ['k'])).toBe(legacy);
  });

  it('keeps whitespace while typing but caps the length so the draft stays syncable', () => {
    const d = draftWithAttic();
    expect(setDeviationAck(d, f, 'Deep ').deviationAcks.k!.note).toBe('Deep ');
    const long = setDeviationAck(d, f, 'x'.repeat(ACK_MAX_LENGTH + 50));
    expect(long.deviationAcks.k!.note).toHaveLength(ACK_MAX_LENGTH);
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
    const acked = flags.reduce((acc, f) => setDeviationAck(acc, f, 'Crawl-only attic, measured'), withOverride);
    expect(ackSummary(flagsOf(acked).flags, acked.deviationAcks).allExplained).toBe(true);
  });
});

describe('a note explains the deviation it was written for (stale acknowledgements)', () => {
  const laborKey = (d: EstimateDraft) => lineKey(d.areas[0]!.id, 'cellulose', 'labor');
  /** The model's person-hours for the attic's cellulose labor line (14.5 h in the fixture). */
  const modelHours = (d: EstimateDraft) =>
    flagsOf(d).priced.options.flatMap((o) => o.lines).find((l) => l.key === laborKey(d))!.modelHours!;
  const laborFlag = (d: EstimateDraft) => flagsOf(d).flags.find((f) => f.lineKey === laborKey(d))!;
  const goodFlag = (d: EstimateDraft) => flagsOf(d).flags.find((f) => f.key === 'good|total_price')!;
  const goodModelPrice = (d: EstimateDraft) => flagsOf(d).priced.options.find((o) => o.tier === 'good')!.modelPrice;
  const withHours = (d: EstimateDraft, factor: number, reason: string) =>
    applyLineOverride(d, laborKey(d), { hours: modelHours(d) * factor, reason, tier: 'better' });

  it('labor +50% explained, reset, then −50%: the −50% flag is not explained by the old note', () => {
    let d = withHours(draftWithAttic(), 1.5, 'Low clearance');
    const up = laborFlag(d);
    expect(up.pctDiff).toBe(0.5);
    d = setDeviationAck(d, up, 'Low clearance, long hose run');
    expect(isAcknowledged(up, d.deviationAcks)).toBe(true);

    d = withHours(removeLineOverride(d, laborKey(d)), 0.5, 'Win the job');
    const down = laborFlag(d);
    expect(down.key).toBe(up.key);
    expect(down.pctDiff).toBe(-0.5);
    expect(isAcknowledged(down, d.deviationAcks)).toBe(false);
    expect(acknowledgedNote(down, d.deviationAcks)).toBeNull();
    expect(unacknowledgedFlags(flagsOf(d).flags, d.deviationAcks)).toContainEqual(down);
  });

  it('flipping direction without a reset keeps the old note pre-filled but pending until confirmed', () => {
    let d = withHours(draftWithAttic(), 1.5, 'Low clearance');
    d = setDeviationAck(d, laborFlag(d), 'Low clearance, long hose run');
    d = withHours(d, 0.5, 'Win the job');
    const down = laborFlag(d);
    expect(ackState(down, d.deviationAcks)).toEqual({ status: 'stale', note: 'Low clearance, long hose run', ackedPctDiff: 0.5 });
    expect(ackSummary(flagsOf(d).flags, d.deviationAcks).allExplained).toBe(false);

    // "Note still applies" re-saves the same note for the deviation as it is now.
    const confirmed = setDeviationAck(d, down, ackState(down, d.deviationAcks).note);
    expect(ackState(down, confirmed.deviationAcks)).toEqual({ status: 'explained', note: 'Low clearance, long hose run', ackedPctDiff: -0.5 });
  });

  it('a bigger change in the same direction needs the note confirmed again', () => {
    let d = withHours(draftWithAttic(), 1.2, 'Low clearance');
    d = setDeviationAck(d, laborFlag(d), 'Low clearance');
    d = withHours(d, 1.4, 'Low clearance and knee walls');
    expect(laborFlag(d).pctDiff).toBe(0.4);
    expect(ackState(laborFlag(d), d.deviationAcks)).toMatchObject({ status: 'stale', ackedPctDiff: 0.2 });
  });

  it('a +30% price note stops counting once the area grows and the price is below the model', () => {
    let d = draftWithAttic();
    d = setPriceOverride(d, 'good', { price: Math.round(goodModelPrice(d) * 1.3), reason: 'Premium install' });
    const up = goodFlag(d);
    expect(up.pctDiff).toBeCloseTo(0.3, 3);
    d = setDeviationAck(d, up, 'Customer asked for the premium install');
    expect(isAcknowledged(up, d.deviationAcks)).toBe(true);

    d = { ...d, areas: [{ ...d.areas[0]!, sqft: 1700 }] };
    const now = goodFlag(d);
    expect(now.pctDiff).toBeLessThan(-0.2);
    expect(ackState(now, d.deviationAcks)).toMatchObject({ status: 'stale', note: 'Customer asked for the premium install' });
    expect(acknowledgedNote(now, d.deviationAcks)).toBeNull();
  });

  it('a small change within the tolerance keeps the note', () => {
    let d = draftWithAttic();
    d = setPriceOverride(d, 'good', { price: Math.round(goodModelPrice(d) * 1.3), reason: 'Premium install' });
    d = setDeviationAck(d, goodFlag(d), 'Customer asked for the premium install');
    const before = goodFlag(d).pctDiff;

    d = { ...d, driveMinutesOneWay: 25 }; // the model price moves a little
    const now = goodFlag(d);
    expect(now.pctDiff).not.toBe(before);
    expect(Math.abs(now.pctDiff - before)).toBeLessThanOrEqual(ACK_PCT_TOLERANCE);
    expect(isAcknowledged(now, d.deviationAcks)).toBe(true);
    expect(acknowledgedNote(now, d.deviationAcks)).toBe('Customer asked for the premium install');
  });

  it('matches on direction and a 2-point absolute tolerance; an unknown deviation never matches', () => {
    expect(ACK_PCT_TOLERANCE).toBe(0.02);
    expect(ackMatchesDeviation(0.3, 0.3)).toBe(true);
    expect(ackMatchesDeviation(0.3, 0.32)).toBe(true);
    expect(ackMatchesDeviation(0.3, 0.28)).toBe(true);
    expect(ackMatchesDeviation(0.3, 0.3201)).toBe(false);
    expect(ackMatchesDeviation(0.3, 0.2799)).toBe(false);
    expect(ackMatchesDeviation(-0.3, -0.31)).toBe(true);
    expect(ackMatchesDeviation(0.3, -0.3)).toBe(false);
    expect(ackMatchesDeviation(0.01, -0.01)).toBe(false);
    expect(ackMatchesDeviation(null, 0.3)).toBe(false);
    expect(ackMatchesDeviation(Number.NaN, 0.3)).toBe(false);
    expect(ackMatchesDeviation(0.3, Number.NaN)).toBe(false);
  });

  it('a note saved by an earlier build (bare string) never counts until confirmed', () => {
    const f = flag({ key: 'k', pctDiff: 0.2 });
    expect(isAcknowledged(f, { k: 'Deep bays' })).toBe(false);
    expect(ackState(f, { k: 'Deep bays' })).toEqual({ status: 'stale', note: 'Deep bays', ackedPctDiff: null });
    expect(acknowledgedNote(f, { k: 'Deep bays' })).toBeNull();
    expect(ackSummary([f], { k: 'Deep bays' })).toMatchObject({ pending: 1, allExplained: false });

    // Drafts on phones and stored client_doc still parse: the note with an unknown deviation.
    const parsed = draftSchema.parse({ ...draftWithAttic(), deviationAcks: { k: ' Deep bays ' } });
    expect(parsed.deviationAcks).toEqual({ k: { note: 'Deep bays', pctDiff: null } });
    expect(isAcknowledged(f, parsed.deviationAcks)).toBe(false);
    expect(isAcknowledged(f, setDeviationAck(parsed, f, 'Deep bays').deviationAcks)).toBe(true);
  });

  it('removing a line override clears the notes on that line only, so the same change later needs a new note', () => {
    let d = withHours(draftWithAttic(), 1.5, 'Low clearance');
    const lineFlag = laborFlag(d);
    expect(lineFlagKeys(laborKey(d))).toContain(lineFlag.key);
    d = setDeviationAck(d, lineFlag, 'Low clearance, long hose run');
    d = setDeviationAck(d, flag({ key: 'better|total_price', pctDiff: 0.1641 }), 'More labor');
    d = setDeviationAck(d, flag({ key: `${laborKey(d)}|qty`, pctDiff: 0.2 }), 'Leftover');

    const reset = removeLineOverride(d, laborKey(d));
    expect(reset.lineOverrides).toEqual({});
    expect(reset.deviationAcks).toEqual({ 'better|total_price': { note: 'More labor', pctDiff: 0.1641 } });
    expect(Object.keys(d.deviationAcks)).toHaveLength(3); // not mutated

    const again = withHours(reset, 1.5, 'Low clearance');
    expect(ackState(laborFlag(again), again.deviationAcks)).toEqual({ status: 'missing', note: '', ackedPctDiff: null });
    // A note left behind without an override goes too; nothing to clear is a no-op.
    const orphan = setDeviationAck(draftWithAttic(), flag({ key: 'x|hours' }), 'orphan');
    expect(removeLineOverride(orphan, 'x').deviationAcks).toEqual({});
    expect(removeLineOverride(reset, 'x')).toBe(reset);
  });

  it("removing a price override clears that option's total-price note; changing it keeps the note for the rule to judge", () => {
    let d = draftWithAttic();
    const price = Math.round(goodModelPrice(d) * 1.3);
    d = setPriceOverride(d, 'good', { price, reason: 'Premium install' });
    const total = goodFlag(d);
    expect(total.key).toBe(totalFlagKey('good'));
    d = setDeviationAck(d, total, 'Customer asked for the premium install');
    d = setDeviationAck(d, flag({ key: totalFlagKey('better') }), 'Other option');

    const changed = setPriceOverride(d, 'good', { price: price + 10, reason: 'Premium install' });
    expect(changed.overrides.good).toEqual({ price: price + 10, reason: 'Premium install' });
    expect(changed.deviationAcks).toEqual(d.deviationAcks);

    const removed = setPriceOverride(d, 'good', null);
    expect(removed.overrides).toEqual({});
    expect(removed.deviationAcks).toEqual({ 'better|total_price': { note: 'Other option', pctDiff: 0.2 } });
    expect(d.overrides.good).toBeDefined(); // not mutated

    const again = setPriceOverride(removed, 'good', { price, reason: 'Premium install' });
    expect(ackState(goodFlag(again), again.deviationAcks).status).toBe('missing');
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

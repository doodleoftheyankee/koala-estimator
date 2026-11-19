import { describe, expect, it } from 'vitest';
import type { DeviationFlag } from '@/lib/learning/types';
import { priceEstimate, type PricingBundle } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { seededBundle } from '@/lib/pricing/__fixtures__/seeded';
import { draftSchema, hasDepthField, newArea, newDraft, priceableAreas, syncableDraftSchema, toEstimateInput, withJobType, type EstimateDraft } from './draft';
import { buildSyncPayload } from './payload';

/** New drafts start in the business profile's town (L32); these tests' estimates are in this one. */
const TOWN = { city: 'Springfield', state: 'IL' };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const bundle: PricingBundle = { hash: 'abc', builtAt: '2026-10-20T00:00:00.000Z', snapshot, coefficientSet: coefficients, winModel: null };

function filledDraft() {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), uuid, TOWN);
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '302-555-0100' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic', uuid), sqft: 1000 }];
  d.driveMinutesOneWay = 20;
  return d;
}

describe('draft', () => {
  it('a new draft is valid but not syncable until it has an area', () => {
    const d = newDraft(new Date(), uuid, TOWN);
    expect(draftSchema.safeParse({ ...d, customer: { ...d.customer, firstName: 'A', lastName: 'B' }, property: { ...d.property, street: 'x', zip: '19711' } }).success).toBe(true);
    expect(syncableDraftSchema.safeParse(d).success).toBe(false);
    expect(syncableDraftSchema.safeParse(filledDraft()).success).toBe(true);
  });

  it('rejects bad input', () => {
    const d = filledDraft();
    expect(draftSchema.safeParse({ ...d, property: { ...d.property, zip: '1971' } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...d, areas: [{ ...d.areas[0]!, sqft: -5 }] }).success).toBe(false);
    expect(draftSchema.safeParse({ ...d, customer: { ...d.customer, email: 'nope' } }).success).toBe(false);
  });

  it('only prices complete areas', () => {
    const d = filledDraft();
    d.areas.push(newArea('walls', uuid)); // sqft 0, incomplete
    expect(priceableAreas(d)).toHaveLength(1);
  });

  it('keeps each deviation note with the deviation it explained; bare-string notes from earlier builds get an unknown one', () => {
    const acks = { a: { note: ' Deep bays ', pctDiff: 0.31 }, b: 'Low clearance', c: { note: 'Old', pctDiff: null } };
    const parsed = draftSchema.parse({ ...filledDraft(), deviationAcks: acks });
    expect(parsed.deviationAcks).toEqual({
      a: { note: 'Deep bays', pctDiff: 0.31 },
      b: { note: 'Low clearance', pctDiff: null },
      c: { note: 'Old', pctDiff: null },
    });
    // What the server stores as client_doc parses back unchanged on the phone.
    expect(draftSchema.parse(JSON.parse(JSON.stringify(parsed))).deviationAcks).toEqual(parsed.deviationAcks);
    expect(draftSchema.safeParse({ ...filledDraft(), deviationAcks: { a: { note: 'x'.repeat(501), pctDiff: 0.2 } } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...filledDraft(), deviationAcks: { a: { note: 'x', pctDiff: '0.2' } } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...filledDraft(), deviationAcks: { a: 5 } }).success).toBe(false);
  });

  it('a cavity depth goes with the job type: changed to attic, an area keeps no hidden depth (review A M1)', () => {
    // The Cavity depth field is shown for walls, rim joists, crawlspaces and garages only.
    expect(['walls', 'rim_joist', 'crawlspace', 'garage'].every((j) => hasDepthField(j as never))).toBe(true);
    expect(hasDepthField('attic') || hasDepthField('commercial')).toBe(false);
    const walls = { ...newArea('walls', uuid), sqft: 1000, depthIn: 3.5 };
    expect(withJobType(walls, 'crawlspace')).toMatchObject({ jobType: 'crawlspace', depthIn: 3.5 });
    expect(withJobType(walls, 'attic')).toMatchObject({ jobType: 'attic', depthIn: null });
  });

  it('a depth stored on an attic (a draft saved before the fix) is not priced: the attic prices to R-49, not to a 3.5 in "cavity" (review A M1)', () => {
    const d = filledDraft();
    d.areas = [{ ...d.areas[0]!, accessLevel: 'easy', depthIn: 3.5 }];
    expect(priceableAreas(d)[0]!.depthIn).toBeNull();
    const priced = priceEstimate({ ...toEstimateInput(d), areas: priceableAreas(d) }, seededBundle.snapshot, seededBundle.coefficientSet);
    const good = priced.options.find((o) => o.tier === 'good')!;
    // Before: Good $1,500 "Blown Cellulose to R-12.6" (fills the 3.5 in cavity).
    expect(good.label).toBe('Blown Cellulose to Code');
    expect(good.customerItems[0]!.description).toBe('Blown Cellulose to R-49 (~13.6" added), 1,000 sq ft');
    expect(good.price).toBe(2995);
  });

  it('every job type gets a sensible default name', () => {
    for (const jt of ['attic', 'walls', 'crawlspace', 'rim_joist', 'garage', 'commercial'] as const) {
      expect(newArea(jt, uuid).name.length).toBeGreaterThan(0);
    }
  });
});

describe('buildSyncPayload', () => {
  const d = filledDraft();
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  const p = buildSyncPayload(d, priced, bundle, { pricedOffline: true, uuid });

  it('maps the estimate header and pins the pricing version', () => {
    expect(p.estimate.id).toBe(d.id);
    expect(p.estimate.coefficient_set_id).toBe('set-1');
    expect(p.estimate.pricing_snapshot_hash).toBe('abc');
    expect(p.estimate.priced_offline).toBe(true);
    expect(p.estimate.status).toBe('draft');
    expect((p.estimate.client_doc as { bundleHash: string }).bundleHash).toBe('abc');
  });

  it('maps every option and line with linked ids', () => {
    expect(p.options).toHaveLength(priced.options.length);
    for (const o of p.options) {
      expect(o.lines.length).toBeGreaterThan(0);
      for (const l of o.lines) expect(l.option_id).toBe(o.id);
    }
    expect(p.areas[0]).toMatchObject({ job_type: 'attic', sqft: 1000, sort_order: 0 });
    expect(p.customer).toMatchObject({ first_name: 'Pat', email: 'pat@example.com' });
  });

  it('never sends a server-only status', () => {
    const sent = buildSyncPayload({ ...d, status: 'sent' }, priced, bundle, { pricedOffline: false, uuid });
    expect(sent.estimate.status).toBe('draft');
    const ready = buildSyncPayload({ ...d, status: 'ready' }, priced, bundle, { pricedOffline: false, uuid });
    expect(ready.estimate.status).toBe('ready');
  });

  it('the model total is the recommended option\'s: the pick, else Better (OD1, L9)', () => {
    const good = buildSyncPayload({ ...d, selectedTier: 'good' }, priced, bundle, { pricedOffline: false, uuid });
    expect(good.estimate.model_total_price).toBe(priced.options.find((o) => o.tier === 'good')!.modelPrice);
    // No pick: Better, as the lists and the quote recommend it (was the first option, Good).
    expect(p.estimate.selected_tier).toBeNull();
    expect(p.estimate.model_total_price).toBe(priced.options.find((o) => o.tier === 'better')!.modelPrice);
    expect(p.estimate.model_total_price).not.toBe(priced.options[0]!.modelPrice);
  });

  it('turns empty contact fields into nulls', () => {
    const blank = buildSyncPayload({ ...d, customer: { ...d.customer, email: '', phone: '' }, notes: '' }, priced, bundle, { pricedOffline: false, uuid });
    expect(blank.customer.email).toBeNull();
    expect(blank.customer.phone).toBeNull();
    expect(blank.estimate.notes).toBeNull();
  });

  it('keeps incomplete areas only in the client doc', () => {
    const withDraftArea = { ...d, areas: [...d.areas, newArea('walls', uuid)] };
    const pl = buildSyncPayload(withDraftArea, priced, bundle, { pricedOffline: false, uuid });
    expect(pl.areas).toHaveLength(1);
    expect((pl.estimate.client_doc as { areas: unknown[] }).areas).toHaveLength(2);
  });

  it('sends each flag with its note string, only while the note explains that deviation', () => {
    const f = (key: string, pctDiff: number): DeviationFlag => ({
      key,
      tier: 'better',
      lineKey: null,
      metric: 'total_price',
      estimatorValue: 1,
      modelValue: 1,
      pctDiff,
      reasons: [],
      message: key,
    });
    const flags = [f('explained', 0.5), f('flipped', -0.5), f('earlier-build', 0.2), f('blank', 0.2), f('none', 0.2)];
    const draft = {
      ...d,
      deviationAcks: {
        explained: { note: ' Low clearance ', pctDiff: 0.5 },
        flipped: { note: 'Low clearance', pctDiff: 0.5 },
        'earlier-build': 'Deep bays',
        blank: { note: '  ', pctDiff: 0.2 },
      },
    } as unknown as EstimateDraft;
    const pl = buildSyncPayload(draft, priced, bundle, { pricedOffline: false, uuid, flags });
    expect(pl.flags.map((x) => [x.flag_key, x.ack_note])).toEqual([
      ['explained', 'Low clearance'],
      ['flipped', null],
      ['earlier-build', null],
      ['blank', null],
      ['none', null],
    ]);
    expect(pl.flags[0]).toMatchObject({ pct_diff: 0.5, tier: 'better', metric: 'total_price' });
  });

  it('handles an estimate with no priceable options', () => {
    const empty = buildSyncPayload(d, { options: [], warnings: [], crewId: 'crew-a' }, bundle, { pricedOffline: false });
    expect(empty.options).toEqual([]);
    expect(empty.estimate.model_total_price).toBeNull();
  });
});

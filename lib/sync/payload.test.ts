import { describe, expect, it } from 'vitest';
import { priceEstimate, type PricingBundle } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { draftSchema, newArea, newDraft, priceableAreas, syncableDraftSchema, toEstimateInput } from './draft';
import { buildSyncPayload } from './payload';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const bundle: PricingBundle = { hash: 'abc', builtAt: '2026-10-20T00:00:00.000Z', snapshot, coefficientSet: coefficients };

function filledDraft() {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), uuid);
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '302-555-0100' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic', uuid), sqft: 1000 }];
  d.driveMinutesOneWay = 20;
  return d;
}

describe('draft', () => {
  it('a new draft is valid but not syncable until it has an area', () => {
    const d = newDraft(new Date(), uuid);
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

  it('uses the selected tier for the model total, falling back to the first option', () => {
    const better = buildSyncPayload({ ...d, selectedTier: 'better' }, priced, bundle, { pricedOffline: false, uuid });
    expect(better.estimate.model_total_price).toBe(priced.options.find((o) => o.tier === 'better')!.modelPrice);
    expect(p.estimate.model_total_price).toBe(priced.options[0]!.modelPrice);
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

  it('handles an estimate with no priceable options', () => {
    const empty = buildSyncPayload(d, { options: [], warnings: [], crewId: 'crew-a' }, bundle, { pricedOffline: false });
    expect(empty.options).toEqual([]);
    expect(empty.estimate.model_total_price).toBeNull();
  });
});

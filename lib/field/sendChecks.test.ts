import { describe, expect, it } from 'vitest';
import { newMeasurement } from '@/lib/measure/measure';
import { priceEstimate, type PriceApproval, type PricedOption } from '@/lib/pricing';
import { seededCoefficients, seededSnapshot } from '@/lib/pricing/__fixtures__/seeded';
import { syncBlocker } from '@/lib/offline/syncCore';
import { newArea, newDraft, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { withMeasurement } from './measuring';
import { sendChecks, type SendCheckInput } from './sendChecks';

const NOW = new Date('2026-11-19T15:00:00Z');

/** A complete estimate: customer with email, address, one attic of 1,200 sq ft. */
function complete(): EstimateDraft {
  const d = newDraft(NOW, undefined, { city: 'Springfield', state: 'IL' });
  return {
    ...d,
    customer: { ...d.customer, firstName: 'Riley', lastName: 'Quinn', email: 'riley@example.com' },
    property: { ...d.property, street: '12 Elm St', zip: '62701' },
    areas: [{ ...newArea('attic'), sqft: 1200 }],
  };
}
const price = (d: EstimateDraft): PricedOption[] => {
  const areas = priceableAreas(d);
  return areas.length ? priceEstimate({ ...toEstimateInput(d), areas }, seededSnapshot, seededCoefficients).options : [];
};
function input(d: EstimateDraft, over: Partial<SendCheckInput> = {}): SendCheckInput {
  return { draft: d, options: price(d), role: 'estimator', settings: seededSnapshot.settings, approvals: [], pendingFlags: 0, profileGaps: [], online: true, ...over };
}
const failing = (i: SendCheckInput) => sendChecks(i).filter((c) => !c.ok);

describe('the Send checklist in plain words, with a Fix per item (L34, RF-02, UX-04)', () => {
  it('a complete estimate passes every check', () => {
    const checks = sendChecks(input(complete()));
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.label)).toEqual([
      'Customer: Riley Quinn',
      'Email: riley@example.com',
      'Address: 12 Elm St, Springfield, IL 62701',
      'Attic: 1,200 sq ft',
      `${price(complete()).length} options priced`,
      'Prices within your limits',
      'Every change from the model is explained',
      'Business profile finished',
      'Online',
    ]);
  });

  it('an area with no size is named, not "Too small: expected number to be >0", with an Add size button', () => {
    const d = complete();
    const crawl = { ...newArea('crawlspace'), sqft: 0 };
    d.areas.push(crawl);
    expect(syncBlocker(d)).toBe('Too small: expected number to be >0'); // what the checklist used to say
    expect(failing(input(d))).toEqual([
      {
        id: `area:${crawl.id}`,
        ok: false,
        label: 'Crawlspace has no size yet. It is not in the price.',
        fix: { label: 'Add size', target: { step: 'areas', areaId: crawl.id, open: 'size' } },
      },
    ]);
  });

  it('a broken measurement is named (RF-07), with Finish measuring', () => {
    const d = complete();
    const walls = { ...newArea('walls'), name: 'Exterior walls' };
    d.areas.push(walls);
    const broken = withMeasurement(d, walls.id, { ...newMeasurement('walls'), perimeter: '120', wallHeight: '' });
    expect(failing(input(broken))).toEqual([
      {
        id: `area:${walls.id}`,
        ok: false,
        label: "Exterior walls: the measurement isn't finished, so this area isn't priced. Enter the average wall height.",
        fix: { label: 'Finish measuring', target: { step: 'areas', areaId: walls.id, open: 'measure' } },
      },
    ]);
  });

  it('no area yet: add one', () => {
    const d = { ...complete(), areas: [] };
    expect(failing(input(d)).map((c) => [c.label, c.fix?.label, c.fix?.target])).toEqual([['Add an area to price.', 'Add an area', { step: 'areas' }]]);
  });

  it("the customer's email, name and address each say what to add and go there", () => {
    const d = complete();
    d.customer = { ...d.customer, firstName: '', email: '' };
    d.property = { ...d.property, street: '', zip: '123' };
    expect(failing(input(d)).map((c) => [c.label, c.fix])).toEqual([
      ["Add the customer's name.", { label: 'Add name', target: { step: 'customer', field: 'firstName' } }],
      ["Add the customer's email to send the quote.", { label: 'Add email', target: { step: 'customer', field: 'email' } }],
      ['Add the street and a 5-digit ZIP code to the address.', { label: 'Add address', target: { step: 'customer', field: 'street' } }],
    ]);
    d.customer.email = 'riley@example';
    expect(failing(input(d))[1]).toMatchObject({ label: "The customer's email doesn't look right.", fix: { label: 'Fix email' } });
  });

  it('a price beyond the estimator\'s range names the price, the model price and the range, with Request approval', () => {
    const d = complete();
    const good = price(d).find((o) => o.tier === 'good')!;
    // Seeded margins: a 15% net margin over a 5% floor, so an estimator's discount meets the floor near
    // their 10% limit; a price 20% above the model shows the limit alone. (Better and Best are the same
    // work on an attic with nothing in it, so Good is the option that can move on its own.)
    const asked = Math.round(good.modelPrice * 1.2);
    d.overrides = { good: { price: asked, reason: 'Attic access through a closet' } };
    const [check, ...rest] = failing(input(d));
    expect(rest).toEqual([]);
    expect(check!.id).toBe('price:good');
    expect(check!.label).toMatch(new RegExp(`^Good: \\$${asked.toLocaleString('en-US')} is 20% above the model price of \\$${good.modelPrice.toLocaleString('en-US')}\\. You can quote \\$[\\d,]+ to \\$[\\d,]+ on your own`));
    expect(check!.fix).toEqual({ label: 'Change the price', target: { step: 'options', tier: 'good' } });
    expect(check!.approval).toMatchObject({ tier: 'good', price: asked, modelPrice: good.modelPrice, belowFloor: false, approver: 'office', status: 'none' });
  });

  it('a request waiting or declined says so; an approved price can be sent', () => {
    const d = complete();
    const good = price(d).find((o) => o.tier === 'good')!;
    const asked = Math.round(good.modelPrice * 1.2);
    d.overrides = { good: { price: asked, reason: 'Attic access through a closet' } };
    const a: PriceApproval = { id: 'a1', estimateId: d.id, tier: 'good', price: asked, modelPrice: good.modelPrice, belowFloor: false, status: 'pending', decidedRole: null, requestedAt: '2026-11-19T15:01:00Z' };
    expect(failing(input(d, { approvals: [a] }))[0]!.approval).toMatchObject({ status: 'pending' });
    const declined = { ...a, status: 'declined' as const, decidedRole: 'owner' as const, decisionNote: 'Too low for a full removal' };
    expect(failing(input(d, { approvals: [declined] }))[0]!.approval).toMatchObject({ status: 'declined', decisionNote: 'Too low for a full removal' });
    const approved = { ...a, status: 'approved' as const, decidedRole: 'owner' as const, requestedAt: '2026-11-19T15:05:00Z' };
    const checks = sendChecks(input(d, { approvals: [declined, approved] }));
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.id === 'price')!.label).toBe('Prices within your limits or approved');
  });

  it('a price change needs a reason before anything else', () => {
    const d = complete();
    d.overrides = { better: { price: 5000, reason: ' ' } };
    expect(failing(input(d, { role: 'office' })).map((c) => [c.label, c.fix])).toEqual([
      ['Better: give a reason for the new price.', { label: 'Add a reason', target: { step: 'options', tier: 'better' } }],
    ]);
  });

  it('changes from the model need a note; the business profile; offline', () => {
    const d = complete();
    const est = failing(input(d, { pendingFlags: 2, profileGaps: ['the license number', 'the office phone'], online: false }));
    expect(est.map((c) => [c.label, c.fix])).toEqual([
      ['2 changes from the model need a short note.', { label: 'Explain', target: { step: 'options' } }],
      ['The business profile is not finished: add the license number and the office phone. Ask the owner or the office to finish it.', undefined],
      ['Offline. Sending needs a connection; your work is saved.', undefined],
    ]);
    const owner = failing(input(d, { role: 'owner', profileGaps: ['the warranty'] }));
    expect(owner.map((c) => [c.label, c.fix])).toEqual([
      ['The business profile is not finished: add the warranty.', { label: 'Open the business profile', target: { step: 'business' } }],
    ]);
  });

  it('every failing item has a way on: a Fix, a Request approval, or it says who to ask', () => {
    const d = complete();
    d.customer = { ...d.customer, lastName: '', email: '' };
    d.areas.push({ ...newArea('rim_joist'), sqft: 0 }, { ...newArea('garage'), name: '', sqft: 300 });
    d.overrides = { good: { price: 100, reason: '' } };
    for (const role of ['estimator', 'office', 'owner'] as const) {
      for (const c of failing(input(d, { role, pendingFlags: 1, profileGaps: ['the terms'] }))) {
        expect(c.fix || c.approval || /Ask the owner|Offline/.test(c.label), `${role}: ${c.label}`).toBeTruthy();
        expect(c.label).not.toMatch(/expected|Too small|Too big|Invalid|undefined|NaN/);
      }
    }
  });
});

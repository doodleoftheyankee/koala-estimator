import { describe, expect, it } from 'vitest';
import * as approvals from './approvals';
import { approvalFromRow, approvalsFromRows, approvedPrices, latestByTier } from './approvals';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  estimate_id: 'e1',
  tier: 'better',
  price: '4500.00',
  model_price: '5420.00',
  below_floor: false,
  status: 'pending',
  decided_role: null,
  note: 'Neighbour discount',
  decision_note: null,
  requested_at: '2026-11-19T15:00:00Z',
  requested_by: 'u1',
  decided_at: null,
  ...over,
});

describe('price approvals as read from the database (L34)', () => {
  it('reads numeric columns as numbers and drops rows it cannot read', () => {
    expect(approvalFromRow(row())).toEqual({
      id: 'a1',
      estimateId: 'e1',
      tier: 'better',
      price: 4500,
      modelPrice: 5420,
      belowFloor: false,
      status: 'pending',
      decidedRole: null,
      note: 'Neighbour discount',
      decisionNote: null,
      requestedAt: '2026-11-19T15:00:00Z',
      requestedBy: 'u1',
      decidedAt: null,
      // A request recorded without its cost (review B database-B2) covers nothing.
      loadedCost: null,
    });
    expect(approvalFromRow(row({ loaded_cost: '3249.20' }))?.loadedCost).toBe(3249.2);
    expect(approvalsFromRows([row(), row({ tier: 'premium' }), null])).toHaveLength(1);
    expect(approvalsFromRows(null)).toEqual([]);
  });

  it('the newest request for the price and model price an option has now', () => {
    const a = approvalsFromRows([
      row({ id: 'old', status: 'declined', decided_role: 'owner', requested_at: '2026-11-19T15:00:00Z' }),
      row({ id: 'new', status: 'pending', requested_at: '2026-11-19T16:00:00Z' }),
      row({ id: 'other-price', price: 4400, status: 'approved', decided_role: 'office', requested_at: '2026-11-19T17:00:00Z' }),
      row({ id: 'good', tier: 'good', price: 3000, model_price: 3200, requested_at: '2026-11-19T14:00:00Z' }),
    ]);
    expect(latestByTier(a, { better: { price: 4500, modelPrice: 5420 } }).better?.id).toBe('new');
    // Re-priced since it was asked: the request no longer speaks for this option.
    expect(latestByTier(a, { better: { price: 4500, modelPrice: 5500 } }).better).toBeUndefined();
    expect(latestByTier(a).better?.id).toBe('other-price');
    expect(latestByTier(a).good?.id).toBe('good');
    expect(approvedPrices(a)).toEqual({ better: [4400] });
  });
});

// Review B database-B2: the phone offers Request approval again when the cost rose after the decision.
describe('a request asked at a lower cost no longer speaks for the option (review B database-B2)', () => {
  it('the newest request at the price, model price and a cost no higher than it was asked at', () => {
    const a = approvalsFromRows([row({ id: 'ok', status: 'approved', decided_role: 'owner', loaded_cost: '3249.20' })]);
    const now = (loadedCost: number) => ({ better: { price: 4500, modelPrice: 5420, loadedCost } });
    expect(latestByTier(a, now(3249.2)).better?.id).toBe('ok');
    expect(latestByTier(a, now(3100)).better?.id).toBe('ok');
    expect(latestByTier(a, now(4938.4)).better).toBeUndefined();
    // Recorded without a cost: not this option's answer either, when the cost is known.
    expect(latestByTier(approvalsFromRows([row({ id: 'old' })]), now(3249.2)).better).toBeUndefined();
  });
});

// Review B flow-B3: the owner's queue keeps only requests that still mean something, and nobody
// decides a request on an estimate the customer signed.
describe("the owner's queue drops stale requests (review B flow-B3)", () => {
  const queueRow = (over: Record<string, unknown> = {}, estimate: Record<string, unknown> = {}) => ({
    ...row({ loaded_cost: '3249.20' }),
    ...over,
    estimate: { id: 'e1', status: 'sent', options: [{ tier: 'better', price: '4500.00', loaded_cost: '3249.20' }, { tier: 'good', price: '3000.00', loaded_cost: '2000.00' }], ...estimate },
  });

  it('keeps a request that matches the estimate as it is now', () => {
    expect(approvals.isLiveRequest(queueRow())).toBe(true);
    expect(approvals.isLiveRequest(queueRow({}, { status: 'draft' }))).toBe(true);
    expect(approvals.isLiveRequest(queueRow({}, { options: [{ tier: 'better', price: 4500, loaded_cost: 3000 }] }))).toBe(true);
  });

  it('drops one whose estimate is signed, lost or void', () => {
    for (const status of ['signed', 'lost', 'void']) expect(approvals.isLiveRequest(queueRow({}, { status })), status).toBe(false);
  });

  it('drops one whose option has another price now, is gone, or costs more than when it was asked', () => {
    expect(approvals.isLiveRequest(queueRow({}, { options: [{ tier: 'better', price: '5175.00', loaded_cost: '3249.20' }] }))).toBe(false);
    expect(approvals.isLiveRequest(queueRow({}, { options: [{ tier: 'good', price: '3000.00', loaded_cost: '2000.00' }] }))).toBe(false);
    expect(approvals.isLiveRequest(queueRow({}, { options: [{ tier: 'better', price: '4500.00', loaded_cost: '4938.40' }] }))).toBe(false);
    expect(approvals.isLiveRequest({ ...queueRow(), estimate: null })).toBe(false);
  });

  it('a decision on a signed estimate is refused with 409, before anything else', () => {
    const pending = approvalFromRow(row())!;
    const refusal = (over: Partial<Parameters<typeof approvals.decisionRefusal>[0]> = {}) =>
      approvals.decisionRefusal({ approval: pending, estimateStatus: 'sent', role: 'owner', userId: 'boss', ...over });
    expect(refusal()).toBeNull();
    expect(refusal({ estimateStatus: 'signed' })).toEqual({ status: 409, error: 'signed', message: 'The customer already signed this quote.' });
    expect(refusal({ approval: { ...pending, status: 'approved' } })).toMatchObject({ status: 409, error: 'decided' });
    expect(refusal({ userId: 'u1' })).toMatchObject({ status: 403, error: 'own_request' });
    expect(refusal({ approval: { ...pending, belowFloor: true }, role: 'office' })).toMatchObject({ status: 403, error: 'owner_only' });
    expect(refusal({ estimateStatus: null })).toMatchObject({ status: 404, error: 'not_found' });
  });
});

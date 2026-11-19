import { describe, expect, it } from 'vitest';
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
    });
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

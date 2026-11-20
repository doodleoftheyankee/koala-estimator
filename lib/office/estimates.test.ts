import { describe, expect, it } from 'vitest';
import { formatShortDateTime } from '@/lib/format';
import { STATUS_META } from '@/components/daymark/StatusBadge';
import {
  activityLine,
  closedWords,
  ESTIMATE_STATUSES,
  estimateKpis,
  estimatesHref,
  headlinePrice,
  isEstimateStatus,
  kpiGroup,
  priceLabel,
  rowStatus,
  statusChips,
  statusFilterValues,
  type LatestQuote,
  type RowStatus,
} from './estimates';
import { sumMoney } from './figures';

const quote = (over: Partial<LatestQuote> = {}): LatestQuote => ({
  id: 'q1',
  version: 1,
  status: 'sent',
  sentAt: '2026-11-17T19:41:00Z',
  signedAt: null,
  signedPrice: null,
  ...over,
});

describe('rowStatus', () => {
  it('uses the estimate status, the same as the field list', () => {
    expect(rowStatus('draft', null)).toBe('draft');
    expect(rowStatus('ready', null)).toBe('draft');
    expect(rowStatus('sent', quote())).toBe('sent');
    expect(rowStatus('viewed', quote({ status: 'viewed' }))).toBe('viewed');
    expect(rowStatus('signed', quote({ status: 'signed' }))).toBe('signed');
    expect(rowStatus('lost', quote({ status: 'declined' }))).toBe('lost');
    expect(rowStatus('expired', quote({ status: 'expired' }))).toBe('expired');
    expect(rowStatus('void', null)).toBe('void');
  });

  it('adds what only the quote knows', () => {
    expect(rowStatus('sent', quote({ status: 'viewed' }))).toBe('viewed');
    expect(rowStatus('sent', quote({ status: 'declined' }))).toBe('declined');
    expect(rowStatus('viewed', quote({ status: 'expired' }))).toBe('expired');
    expect(rowStatus('sent', quote({ status: 'signed' }))).toBe('signed');
    expect(rowStatus('ready', quote({ status: 'signed' }))).toBe('signed');
  });

  it('keeps a changed-after-sending estimate a Draft, as the phone shows it', () => {
    expect(rowStatus('draft', quote({ status: 'sent' }))).toBe('draft');
    expect(activityLine('draft', quote({ version: 2 }), null)).toBe('Changed after quote v2 was sent');
  });

  it('only ever says a word from the one vocabulary (or Void)', () => {
    const quoteStatuses = [null, 'sent', 'viewed', 'signed', 'declined', 'expired', 'superseded'];
    for (const s of ESTIMATE_STATUSES)
      for (const q of quoteStatuses) {
        const r = rowStatus(s, q ? { status: q } : null);
        expect(r === 'void' || r in STATUS_META).toBe(true);
      }
  });

  it('recognises statuses', () => {
    expect(isEstimateStatus('ready')).toBe(true);
    expect(isEstimateStatus('declined')).toBe(false);
    expect(isEstimateStatus(undefined)).toBe(false);
  });
});

describe('headlinePrice', () => {
  const options = [
    { tier: 'best', price: 6920 },
    { tier: 'good', price: 2375 },
    { tier: 'better', price: 4095 },
  ];

  it('shows the recommended option when the estimator picked one', () => {
    expect(headlinePrice({ selectedTier: 'best', options, modelTotalPrice: 6000, signedPrice: null })).toEqual({ price: 6920, tier: 'best', signed: false });
    expect(headlinePrice({ selectedTier: 'better', options, modelTotalPrice: 2375, signedPrice: null })).toEqual({ price: 4095, tier: 'better', signed: false });
  });

  it('with no pick, shows Better, the option every other list and the quote recommend (OD1, L9)', () => {
    // Before: the stored model price ($2,375, the first option's), with no option named.
    expect(headlinePrice({ selectedTier: null, options, modelTotalPrice: 2375, signedPrice: null })).toEqual({ price: 4095, tier: 'better', signed: false });
    expect(headlinePrice({ selectedTier: 'nonsense', options, modelTotalPrice: 2375, signedPrice: null })).toEqual({ price: 4095, tier: 'better', signed: false });
  });

  it('when the pick is no longer shown, shows the next option shown (OD1, OD6, L9)', () => {
    const shown = options.filter((o) => o.tier !== 'good');
    expect(headlinePrice({ selectedTier: 'good', options: shown, modelTotalPrice: 2375, signedPrice: null })).toEqual({ price: 4095, tier: 'better', signed: false });
  });

  it('falls back to the stored model price when the recommended option has no price', () => {
    expect(headlinePrice({ selectedTier: 'good', options: [{ tier: 'good', price: null }], modelTotalPrice: 3100, signedPrice: null })).toEqual({ price: 3100, tier: null, signed: false });
    expect(headlinePrice({ selectedTier: null, options: [], modelTotalPrice: 3100, signedPrice: null })).toEqual({ price: 3100, tier: null, signed: false });
    expect(headlinePrice({ selectedTier: null, options: [{ tier: 'good', price: null }], modelTotalPrice: null, signedPrice: null }).price).toBeNull();
    expect(headlinePrice({ selectedTier: 'nonsense', options: null, modelTotalPrice: null, signedPrice: null })).toEqual({ price: null, tier: null, signed: false });
  });

  it('shows the signed price once the customer signed', () => {
    expect(headlinePrice({ selectedTier: 'good', options, modelTotalPrice: 2375, signedPrice: 2500 })).toEqual({ price: 2500, tier: 'good', signed: true });
  });

  it('never changes a value: the price is one the server stored', () => {
    for (const sel of [null, 'good', 'better', 'best']) {
      const p = headlinePrice({ selectedTier: sel, options, modelTotalPrice: 1, signedPrice: null }).price;
      expect([...options.map((o) => o.price), 1]).toContain(p);
    }
  });

  it('names the price', () => {
    expect(priceLabel({ price: 4095, tier: 'better', signed: false })).toBe('Better');
    expect(priceLabel({ price: 2500, tier: 'good', signed: true })).toBe('Signed, Good');
    expect(priceLabel({ price: 2500, tier: null, signed: true })).toBe('Signed');
    expect(priceLabel({ price: 3100, tier: null, signed: false })).toBeNull();
    expect(priceLabel({ price: null, tier: null, signed: false })).toBeNull();
  });
});

describe('activityLine', () => {
  it('says what last happened in plain words', () => {
    const at = '2026-11-17T19:41:00Z';
    expect(activityLine('sent', quote({ sentAt: at }), null)).toBe(`Quote v1 sent ${formatShortDateTime(at)}`);
    expect(activityLine('viewed', quote({ sentAt: null }), null)).toBe('Quote v1 sent');
    expect(activityLine('signed', quote({ signedAt: at }), null)).toBe(`Signed ${formatShortDateTime(at)}`);
    expect(activityLine('signed', quote(), null)).toBe('Quote v1 signed');
    expect(activityLine('signed', null, null)).toBeNull();
    expect(activityLine('declined', quote(), null)).toBe('Quote v1 declined');
    expect(activityLine('expired', quote({ version: 3 }), null)).toBe('Quote v3 expired');
    expect(activityLine('expired', null, null)).toBe('Price hold ran out');
    expect(activityLine('lost', quote(), '  Went with a competitor ')).toBe('Lost: Went with a competitor');
    expect(activityLine('lost', null, null)).toBe('Marked lost');
    expect(activityLine('draft', null, null)).toBe('Not sent yet');
    expect(activityLine('void', null, null)).toBeNull();
    expect(activityLine('sent', null, null)).toBeNull();
  });
});

describe('estimateKpis', () => {
  const rows: Array<{ status: RowStatus; price: number | null }> = [
    { status: 'sent', price: 4780 },
    { status: 'viewed', price: 3975.5 },
    { status: 'sent', price: null },
    { status: 'signed', price: 5060 },
    { status: 'draft', price: 2375 },
    { status: 'draft', price: null },
    { status: 'lost', price: 4120 },
    { status: 'declined', price: 3000 },
    { status: 'expired', price: 2000 },
    { status: 'void', price: 1000 },
  ];

  it('counts each row once, and the tiles add up to the list', () => {
    const k = estimateKpis(rows);
    expect(k.waiting.count + k.signed.count + k.drafts.count + k.closed.count).toBe(rows.length);
  });

  it('adds only the rows a tile names, to the cent, and says how many had no price', () => {
    const k = estimateKpis(rows);
    expect(k.waiting).toEqual({ count: 3, total: 8755.5, unpriced: 1 });
    expect(k.signed).toEqual({ count: 1, total: 5060, unpriced: 0 });
    expect(k.drafts).toEqual({ count: 2, total: 2375, unpriced: 1 });
  });

  it('never puts lost, declined, expired or void rows in a money total', () => {
    const k = estimateKpis(rows);
    expect(k.closed).toEqual({ count: 4, lost: 1, declined: 1, expired: 1, void: 1 });
    const moneyRows = rows.filter((r) => ['waiting', 'signed', 'drafts'].includes(kpiGroup(r.status)));
    const all = sumMoney(moneyRows.map((r) => r.price).filter((p): p is number => p !== null));
    expect((k.waiting.total ?? 0) + (k.signed.total ?? 0) + (k.drafts.total ?? 0)).toBeCloseTo(all, 2);
    expect(closedWords(k.closed)).toBe('1 lost, 1 declined, 1 expired and 1 void');
  });

  it('has no total when nothing in a group has a price', () => {
    const k = estimateKpis([{ status: 'sent', price: null }]);
    expect(k.waiting).toEqual({ count: 1, total: null, unpriced: 1 });
    expect(estimateKpis([]).signed).toEqual({ count: 0, total: null, unpriced: 0 });
    expect(closedWords(estimateKpis([]).closed)).toBeNull();
    expect(closedWords({ count: 2, lost: 2, declined: 0, expired: 0, void: 0 })).toBe('2 lost');
  });

  it('adds money without float noise', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([4321.5, 0.25])).toBe(4321.75);
  });
});

describe('filters', () => {
  it('Draft also finds ready estimates; every other value filters as before', () => {
    expect(statusFilterValues('draft')).toEqual(['draft', 'ready']);
    for (const s of ESTIMATE_STATUSES.filter((x) => x !== 'draft')) expect(statusFilterValues(s)).toEqual([s]);
  });

  it('offers the everyday chips, and a chip for an old link that asks for another status', () => {
    expect(statusChips(null).map((c) => c.label)).toEqual(['All', 'Draft', 'Sent', 'Viewed', 'Signed', 'Lost', 'Expired']);
    expect(statusChips(null).filter((c) => c.current).map((c) => c.label)).toEqual(['All']);
    expect(statusChips('sent').filter((c) => c.current).map((c) => c.value)).toEqual(['sent']);
    const ready = statusChips('ready');
    expect(ready[ready.length - 1]).toEqual({ value: 'ready', label: 'Ready to send', current: true });
  });

  it('keeps the existing URLs', () => {
    expect(estimatesHref({ status: null, estimator: null })).toBe('/estimates');
    expect(estimatesHref({ status: 'sent', estimator: null })).toBe('/estimates?status=sent');
    expect(estimatesHref({ status: 'lost', estimator: 'a1b2' })).toBe('/estimates?status=lost&estimator=a1b2');
    expect(estimatesHref({ status: null, estimator: 'a1b2' })).toBe('/estimates?estimator=a1b2');
  });
});

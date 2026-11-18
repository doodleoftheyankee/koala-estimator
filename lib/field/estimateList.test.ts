import { describe, expect, it } from 'vitest';
import type { LocalEstimate, SyncState } from '@/lib/offline/db';
import { newArea, newDraft, type EstimateDraft } from '@/lib/sync/draft';
import { quoteNumber } from '@/lib/quotes/model';
import {
  boardCounts,
  bySection,
  daySection,
  groupOf,
  matchesFilter,
  matchesSearch,
  onlyInAll,
  phoneSyncState,
  rowStatus,
  toRow,
  toRows,
  waitingTotal,
  type EstimateRow,
} from './estimateList';

// Wednesday Nov 18, 2026, 3 PM in New York (the business time zone).
const NOW = new Date('2026-11-18T20:00:00Z');

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function estimate(over: {
  status?: EstimateDraft['status'];
  sync?: SyncState;
  first?: string;
  last?: string;
  street?: string;
  areas?: Array<{ name: string; sqft: number }>;
  updatedAt?: string;
  price?: number | null;
  tier?: 'good' | 'better' | 'best' | null;
  lastQuote?: EstimateDraft['lastQuote'];
}): LocalEstimate {
  const d = newDraft(new Date('2026-11-01T12:00:00Z'), uuid);
  d.status = over.status ?? 'draft';
  d.customer.firstName = over.first ?? 'Pat';
  d.customer.lastName = over.last ?? 'Lee';
  d.property.street = over.street ?? '12 Elkton Rd';
  d.areas = (over.areas ?? [{ name: 'Attic', sqft: 1200 }]).map((a) => ({ ...newArea('attic', uuid), name: a.name, sqft: a.sqft }));
  d.lastQuote = over.lastQuote ?? null;
  const updatedAt = over.updatedAt ?? '2026-11-18T19:58:00Z';
  return {
    id: d.id,
    ownerId: 'u1',
    draft: d,
    syncState: over.sync ?? 'synced',
    mutationId: uuid(),
    lastError: null,
    serverDoc: null,
    serverRowVersion: null,
    updatedAt,
    syncedAt: updatedAt,
    summaryPrice: over.price === undefined ? null : over.price,
    summaryTier: over.tier,
  };
}

describe('rowStatus: the badge comes from the status the phone has', () => {
  it('shows each server status as itself', () => {
    for (const s of ['sent', 'viewed', 'signed', 'expired', 'lost', 'void'] as const) expect(rowStatus(s, 'synced')).toBe(s);
  });
  it('shows draft and ready as Draft (not sent yet)', () => {
    expect(rowStatus('draft', 'pending')).toBe('draft');
    expect(rowStatus('ready', 'synced')).toBe('draft');
  });
  it('shows a quote the server says is signed as Signed, whatever the stored status', () => {
    expect(rowStatus('draft', 'locked')).toBe('signed');
  });
  it('groups Viewed with Sent, and leaves lost, expired and void to All', () => {
    expect(groupOf('viewed')).toBe('sent');
    expect(groupOf('sent')).toBe('sent');
    expect(groupOf('draft')).toBe('drafts');
    expect(groupOf('signed')).toBe('signed');
    expect(groupOf('lost')).toBeNull();
    expect(groupOf('expired')).toBeNull();
    expect(groupOf('void')).toBeNull();
  });
});

describe('toRow', () => {
  it('says what the phone knows: name, street, areas, status and sync', () => {
    const r = toRow(estimate({ areas: [{ name: 'Attic', sqft: 1200 }, { name: 'Exterior walls', sqft: 800 }, { name: 'attic', sqft: 300 }], sync: 'pending' }), NOW);
    expect(r.name).toBe('Pat Lee');
    expect(r.street).toBe('12 Elkton Rd');
    expect(r.areas).toBe('Attic, Exterior walls');
    expect(r.status).toBe('draft');
    expect(r.sync).toBe('phone');
  });

  it('names a blank customer and a blank street plainly', () => {
    const r = toRow(estimate({ first: '', last: '', street: '  ', areas: [] }), NOW);
    expect(r.name).toBe('New customer');
    expect(r.street).toBeNull();
    expect(r.areas).toBe('');
    expect(r.unpriceable).toBe(true);
  });

  it('marks every state that has not reached the office', () => {
    for (const s of ['local', 'pending', 'error'] as const) expect(toRow(estimate({ sync: s }), NOW).sync).toBe('phone');
    expect(toRow(estimate({ sync: 'conflict' }), NOW).sync).toBe('conflict');
    expect(toRow(estimate({ sync: 'invalid' }), NOW).sync).toBe('invalid');
    expect(toRow(estimate({ sync: 'synced' }), NOW).sync).toBe('synced');
    expect(toRow(estimate({ sync: 'locked', status: 'signed' }), NOW).sync).toBe('synced');
  });

  it('shows a price only when one was saved, named by its option', () => {
    expect(toRow(estimate({ price: 4780, tier: 'better' }), NOW)).toMatchObject({ price: 4780, priceLabel: 'Better' });
    expect(toRow(estimate({ price: 4780 }), NOW)).toMatchObject({ price: 4780, priceLabel: 'Recommended' });
    expect(toRow(estimate({ price: null }), NOW)).toMatchObject({ price: null, priceLabel: null, unpriceable: false });
    expect(toRow(estimate({ price: 0 }), NOW).price).toBeNull();
    expect(toRow(estimate({ price: Number.NaN }), NOW).price).toBeNull();
  });

  it('only calls a row unpriceable when no area is complete', () => {
    expect(toRow(estimate({ areas: [{ name: 'Attic', sqft: 0 }] }), NOW).unpriceable).toBe(true);
    expect(toRow(estimate({ areas: [{ name: 'Attic', sqft: 0 }, { name: 'Garage', sqft: 300 }] }), NOW).unpriceable).toBe(false);
  });

  it('gives the quote number the customer sees, and the send time as the activity', () => {
    const e = estimate({ status: 'sent', lastQuote: { quoteId: uuid(), version: 2, sentAt: '2026-11-17T14:12:00Z' } });
    const r = toRow(e, NOW);
    expect(r.quoteNumber).toBe(quoteNumber(e.id, 2, new Date('2026-11-17T14:12:00Z')));
    expect(r.activity).toBe('Quote v2 sent Nov 17 · 9:12 AM');
  });

  it('says when a sent quote has been changed since, instead of calling it sent', () => {
    const r = toRow(estimate({ status: 'draft', sync: 'pending', lastQuote: { quoteId: uuid(), version: 1, sentAt: '2026-11-17T14:12:00Z' } }), NOW);
    expect(r.status).toBe('draft');
    expect(r.activity).toBe('Changed after quote v1 was sent');
  });

  it('says when it was last changed otherwise, and what to do about conflicts', () => {
    expect(toRow(estimate({ updatedAt: '2026-11-18T19:58:00Z' }), NOW).activity).toBe('Updated 2 min ago');
    expect(toRow(estimate({ sync: 'local', updatedAt: '2026-11-18T19:58:00Z' }), NOW).activity).toBe('Not finished yet · updated 2 min ago');
    expect(toRow(estimate({ sync: 'conflict' }), NOW).activity).toMatch(/another device/);
    expect(toRow(estimate({ sync: 'invalid' }), NOW).activity).toMatch(/could not save/);
  });
});

describe('daySection, in the business time zone', () => {
  it('puts the business day so far under Today', () => {
    expect(daySection('2026-11-18T05:30:00Z', NOW)).toBe('today'); // 12:30 AM Nov 18 in New York
    expect(daySection('2026-11-18T19:59:00Z', NOW)).toBe('today');
    expect(daySection('2026-11-18T21:00:00Z', NOW)).toBe('today'); // a clock a little ahead
  });
  it('puts late last night in New York under This week, though it is already the 18th in UTC', () => {
    expect(daySection('2026-11-18T04:30:00Z', NOW)).toBe('week'); // 11:30 PM Nov 17
  });
  it('starts the week on Monday', () => {
    expect(daySection('2026-11-16T15:00:00Z', NOW)).toBe('week'); // Monday
    expect(daySection('2026-11-15T15:00:00Z', NOW)).toBe('earlier'); // Sunday
  });
  it('on a Monday, yesterday is Earlier', () => {
    expect(daySection('2026-11-15T15:00:00Z', new Date('2026-11-16T15:00:00Z'))).toBe('earlier');
  });
  it('treats a bad date as Earlier', () => {
    expect(daySection('not a date', NOW)).toBe('earlier');
  });
});

describe('search and filter', () => {
  const sent = toRow(estimate({ first: 'Jordan', last: 'Blake', street: '14 Main St', status: 'sent', lastQuote: { quoteId: uuid(), version: 1, sentAt: '2026-11-17T14:12:00Z' } }), NOW);
  it('finds by name, street or quote number', () => {
    expect(matchesSearch(sent, 'blake')).toBe(true);
    expect(matchesSearch(sent, '  JORDAN  blake ')).toBe(true);
    expect(matchesSearch(sent, 'main st')).toBe(true);
    expect(matchesSearch(sent, sent.quoteNumber!)).toBe(true);
    expect(matchesSearch(sent, sent.quoteNumber!.replace(/-/g, ' ').toLowerCase())).toBe(true);
    expect(matchesSearch(sent, 'elkton')).toBe(false);
    expect(matchesSearch(sent, '')).toBe(true);
  });
  it('a row with no quote is not found by punctuation alone', () => {
    const draft = toRow(estimate({}), NOW);
    expect(matchesSearch(draft, '--')).toBe(false);
  });
  it('filters by tile', () => {
    expect(matchesFilter(sent, 'sent')).toBe(true);
    expect(matchesFilter(sent, 'all')).toBe(true);
    expect(matchesFilter(sent, 'drafts')).toBe(false);
  });
});

describe('the status board adds up', () => {
  const rows: EstimateRow[] = toRows(
    [
      estimate({ status: 'draft', sync: 'local' }),
      estimate({ status: 'ready' }),
      estimate({ status: 'sent', price: 4780, tier: 'better' }),
      estimate({ status: 'viewed', price: 3350, tier: 'good' }),
      estimate({ status: 'signed', sync: 'locked', price: 6920, tier: 'best' }),
      estimate({ status: 'lost' }),
      estimate({ status: 'lost' }),
      estimate({ status: 'expired' }),
    ],
    NOW,
  );
  it('counts each tile from the same rows, and All is every row', () => {
    const c = boardCounts(rows);
    expect(c).toEqual({ all: 8, drafts: 2, sent: 2, signed: 1, lost: 2, expired: 1, void: 0 });
    expect(c.drafts + c.sent + c.signed + c.lost + c.expired + c.void).toBe(c.all);
  });
  it('names what only All counts', () => {
    expect(onlyInAll(boardCounts(rows))).toBe('2 lost and 1 expired');
    expect(onlyInAll({ all: 1, drafts: 0, sent: 0, signed: 0, lost: 0, expired: 0, void: 1 })).toBe('1 void');
    expect(onlyInAll({ all: 3, drafts: 0, sent: 0, signed: 0, lost: 1, expired: 1, void: 1 })).toBe('1 lost, 1 expired and 1 void');
    expect(onlyInAll({ all: 1, drafts: 1, sent: 0, signed: 0, lost: 0, expired: 0, void: 0 })).toBeNull();
  });
  it('the waiting total is the sum of exactly the Sent and Viewed rows it counts', () => {
    const w = waitingTotal(rows)!;
    const counted = rows.filter((r) => r.status === 'sent' || r.status === 'viewed');
    expect(w.count).toBe(counted.length);
    expect(w.total).toBe(counted.reduce((s, r) => s + r.price!, 0));
    expect(w.total).toBe(4780 + 3350);
  });
  it('leaves the total out when a waiting row has no saved price, or none are waiting', () => {
    expect(waitingTotal(toRows([estimate({ status: 'sent', price: 4780 }), estimate({ status: 'viewed' })], NOW))).toBeNull();
    expect(waitingTotal(toRows([estimate({ status: 'draft', price: 4780 })], NOW))).toBeNull();
  });
});

describe('sections and order', () => {
  it('sorts newest first and splits by day, leaving empty sections out', () => {
    const rows = toRows(
      [
        estimate({ last: 'Old', updatedAt: '2026-11-02T15:00:00Z' }),
        estimate({ last: 'Today', updatedAt: '2026-11-18T19:00:00Z' }),
        estimate({ last: 'Newest', updatedAt: '2026-11-18T19:59:00Z' }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(['Pat Newest', 'Pat Today', 'Pat Old']);
    expect(bySection(rows).map((s) => [s.label, s.rows.length])).toEqual([
      ['Today', 2],
      ['Earlier', 1],
    ]);
  });
});

describe('phoneSyncState: one state for the header', () => {
  const LAST = '2026-11-18T19:58:00Z';
  const s = (states: SyncState[], online = true, syncing = false, lastSync: string | null = LAST) =>
    phoneSyncState(states.map((syncState) => ({ syncState })), { online, syncing, lastSync });
  it('offline wins and still counts what is waiting', () => {
    expect(s(['pending', 'error', 'conflict', 'synced'], false)).toEqual({ state: 'offline', waiting: 2, problems: 1 });
  });
  it('does not count unfinished drafts as waiting: they sync once finished', () => {
    expect(s(['local', 'synced'])).toEqual({ state: 'synced', waiting: 0, problems: 0 });
    expect(s(['local', 'pending'], false).waiting).toBe(1);
  });
  it('then a sync in progress, then problems, then waiting rows', () => {
    expect(s(['pending'], true, true).state).toBe('syncing');
    expect(s(['pending', 'invalid']).state).toBe('conflict');
    expect(s(['pending', 'error', 'synced'])).toEqual({ state: 'pending', waiting: 2, problems: 0 });
    expect(s(['synced', 'locked']).state).toBe('synced');
    expect(s([]).state).toBe('synced');
  });
  it('a phone that has never read the office list is not called synced', () => {
    expect(s([], true, false, null)).toEqual({ state: 'pending', waiting: 0, problems: 0 });
    expect(s(['synced'], false, false, null).state).toBe('offline');
  });
});

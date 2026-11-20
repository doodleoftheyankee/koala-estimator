// The estimator's home list (app/field/EstimateList.tsx): what each row says, which tile of the
// status board it counts under, which day section it sits in, and the search. Pure, so the list
// can only ever show what the phone really knows:
//
//  - Status comes from the estimate's status as the server last reported it (sent, viewed,
//    signed, lost, expired) or from this phone (draft). Sync state is never a status: an
//    estimate that has not reached the office yet is marked "On this phone" beside its status.
//  - A price shows only when the phone saved one for the row, with the option it belongs to.
//    Nothing is re-priced here, so a sent quote never shows a price it was not sent with.
//  - Totals say exactly what they count, and are left out when any row they would count has no
//    saved price.
import type { LocalEstimate, SyncState } from '@/lib/offline/db';
import type { Tier } from '@/lib/pricing';
import { legacyQuoteNumber } from '@/lib/quotes/model';
import { priceableAreas } from '@/lib/sync/draft';
import { businessDate, formatShortDateTime, relativeTime, TIER_LABELS } from '@/lib/format';

/** The badge a row shows: the one quote vocabulary, plus Void for an estimate the office voided. */
export type RowStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'expired' | 'lost' | 'void';

/** The status board's tiles. Lost, expired and void count only under All. */
export type BoardFilter = 'all' | 'drafts' | 'sent' | 'signed';

/** Where the row's latest version lives. */
export type RowSync = 'synced' | 'phone' | 'conflict' | 'invalid';

export type DaySection = 'today' | 'week' | 'earlier';

export const DAY_SECTIONS: ReadonlyArray<{ key: DaySection; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'earlier', label: 'Earlier' },
];

export interface EstimateRow {
  id: string;
  /** "Pat Lee", or "New customer" before a name is typed. */
  name: string;
  /** Street, or null before one is typed. */
  street: string | null;
  /** The area names, in order, without repeats ("Attic, Exterior walls"); "" when none. */
  areas: string;
  status: RowStatus;
  /** The board tile this row counts under (null: only under All). */
  group: Exclude<BoardFilter, 'all'> | null;
  sync: RowSync;
  /** The saved headline price, or null when the phone has none for this row. */
  price: number | null;
  /** What the price is: the option's name ("Better"), or "Recommended" when the option was not saved with it. */
  priceLabel: string | null;
  /** True when no area is complete enough to price, so "Not priced" is a fact. */
  unpriceable: boolean;
  /** One line of what last happened. */
  activity: string;
  /** The customer-facing quote number of the last quote sent, as the quote shows it. */
  quoteNumber: string | null;
  updatedAt: string;
  section: DaySection;
}

const UNSYNCED: ReadonlySet<SyncState> = new Set(['local', 'pending', 'error']);
/** Complete and queued: goes up by itself at the next sync ('local' waits for the estimator to finish it). */
const QUEUED: ReadonlySet<SyncState> = new Set(['pending', 'error']);

/** The badge for an estimate status as stored on the phone. */
export function rowStatus(status: string, sync: SyncState): RowStatus {
  if (sync === 'locked') return 'signed';
  switch (status) {
    case 'sent':
    case 'viewed':
    case 'signed':
    case 'expired':
    case 'lost':
    case 'void':
      return status;
    default:
      // draft, ready (complete, not sent yet), or anything unknown: not sent.
      return 'draft';
  }
}

export function groupOf(status: RowStatus): EstimateRow['group'] {
  if (status === 'draft') return 'drafts';
  if (status === 'sent' || status === 'viewed') return 'sent';
  if (status === 'signed') return 'signed';
  return null;
}

export function rowSync(sync: SyncState): RowSync {
  if (sync === 'conflict') return 'conflict';
  if (sync === 'invalid') return 'invalid';
  return UNSYNCED.has(sync) ? 'phone' : 'synced';
}

/** Monday (YYYY-MM-DD) of the week holding a business-zone date (YYYY-MM-DD). */
function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

/** Today, earlier this week (weeks start on Monday) or earlier, by the business time zone's calendar. */
export function daySection(at: string, now: Date): DaySection {
  const day = businessDate(at);
  const today = businessDate(now);
  if (!day || !today) return 'earlier';
  if (day >= today) return 'today'; // a clock a little ahead still counts as today
  return day >= mondayOf(today) ? 'week' : 'earlier';
}

function uniq(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function activityLine(e: LocalEstimate, status: RowStatus, now: Date): string {
  const q = e.draft.lastQuote;
  if (e.syncState === 'conflict') return 'Changed on another device too. Open it to choose.';
  if (e.syncState === 'invalid') return 'The office could not save it. Open it to fix.';
  if (q && status !== 'draft') return `Quote v${q.version} sent ${formatShortDateTime(q.sentAt)}`;
  if (q) return `Changed after quote v${q.version} was sent`;
  const updated = relativeTime(e.updatedAt, now.getTime());
  // Incomplete drafts do not sync until finished (lib/offline/syncCore syncBlocker).
  if (e.syncState === 'local') return `Not finished yet · updated ${updated}`;
  return `Updated ${updated}`;
}

/** Everything one row of the list shows, from the stored estimate. */
export function toRow(e: LocalEstimate, now: Date): EstimateRow {
  const d = e.draft;
  const status = rowStatus(d.status, e.syncState);
  const price = typeof e.summaryPrice === 'number' && Number.isFinite(e.summaryPrice) && e.summaryPrice > 0 ? e.summaryPrice : null;
  const tier: Tier | null | undefined = e.summaryTier;
  const q = d.lastQuote;
  return {
    id: e.id,
    name: `${d.customer.firstName} ${d.customer.lastName}`.trim() || 'New customer',
    street: d.property.street.trim() || null,
    areas: uniq(d.areas.map((a) => a.name)).join(', '),
    status,
    group: groupOf(status),
    sync: rowSync(e.syncState),
    price,
    priceLabel: price === null ? null : tier ? TIER_LABELS[tier] : 'Recommended',
    unpriceable: priceableAreas(d).length === 0,
    activity: activityLine(e, status, now),
    // The number the quote was sent with; a quote sent before the phone kept it has its old number.
    quoteNumber: q ? (q.quoteNumber ?? legacyQuoteNumber(d.id, q.version, new Date(q.sentAt))) : null,
    updatedAt: e.updatedAt,
    section: daySection(e.updatedAt, now),
  };
}

/** Newest change first. */
export function toRows(estimates: readonly LocalEstimate[], now: Date): EstimateRow[] {
  return estimates
    .map((e) => toRow(e, now))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Search by name, street or quote number. Case and spacing do not matter; dashes in a quote number are optional. */
export function matchesSearch(row: EstimateRow, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  if (norm(row.name).includes(q) || (row.street && norm(row.street).includes(q))) return true;
  const qc = compact(query);
  return !!row.quoteNumber && qc.length > 0 && compact(row.quoteNumber).includes(qc);
}

export function matchesFilter(row: EstimateRow, filter: BoardFilter): boolean {
  return filter === 'all' || row.group === filter;
}

export interface BoardCounts {
  all: number;
  drafts: number;
  sent: number;
  signed: number;
  /** Rows counted only under All. */
  lost: number;
  expired: number;
  void: number;
}

export function boardCounts(rows: readonly EstimateRow[]): BoardCounts {
  const c: BoardCounts = { all: rows.length, drafts: 0, sent: 0, signed: 0, lost: 0, expired: 0, void: 0 };
  for (const r of rows) {
    if (r.group) c[r.group] += 1;
    else if (r.status === 'lost' || r.status === 'expired' || r.status === 'void') c[r.status] += 1;
  }
  return c;
}

/**
 * The rows that All counts but no other tile does, in words ("2 lost and 1 expired"), so the
 * tiles add up. Null when there are none.
 */
export function onlyInAll(c: BoardCounts): string | null {
  const parts = [
    c.lost ? `${c.lost} lost` : null,
    c.expired ? `${c.expired} expired` : null,
    c.void ? `${c.void} void` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The total of the quotes waiting for the customer (Sent and Viewed): the sum of exactly the
 * prices those rows show. Null when there are none, or when any of them has no saved price
 * (a partial total would mislead).
 */
export function waitingTotal(rows: readonly EstimateRow[]): { total: number; count: number } | null {
  const waiting = rows.filter((r) => r.group === 'sent');
  if (waiting.length === 0 || waiting.some((r) => r.price === null)) return null;
  return { total: waiting.reduce((sum, r) => sum + (r.price ?? 0), 0), count: waiting.length };
}

/** Rows split into Today / This week / Earlier, keeping their order; empty sections are left out. */
export function bySection(rows: readonly EstimateRow[]): Array<{ key: DaySection; label: string; rows: EstimateRow[] }> {
  return DAY_SECTIONS.map((s) => ({ ...s, rows: rows.filter((r) => r.section === s.key) })).filter((s) => s.rows.length > 0);
}

export type PhoneSyncState = 'synced' | 'syncing' | 'pending' | 'offline' | 'conflict';

/**
 * The one sync state for the header: offline first, then a sync the person asked for, then rows
 * that need a look (conflict, or refused by the office), then rows waiting to go up. A phone that
 * has never read the office's list is not "Synced", even with nothing waiting. `waiting` counts
 * only estimates that will sync by themselves; unfinished drafts are marked on their own rows.
 */
export function phoneSyncState(
  estimates: ReadonlyArray<Pick<LocalEstimate, 'syncState'>>,
  opts: { online: boolean; syncing: boolean; lastSync: string | null },
): { state: PhoneSyncState; waiting: number; problems: number } {
  const waiting = estimates.filter((e) => QUEUED.has(e.syncState)).length;
  const problems = estimates.filter((e) => e.syncState === 'conflict' || e.syncState === 'invalid').length;
  const state: PhoneSyncState = !opts.online
    ? 'offline'
    : opts.syncing
      ? 'syncing'
      : problems
        ? 'conflict'
        : waiting || !opts.lastSync
          ? 'pending'
          : 'synced';
  return { state, waiting, problems };
}

// How the office jobs list (/jobs) loads. Pure: the queries are described here and run by
// app/jobs/data.ts through the signed-in user's client (staff RLS).
//
// Each office group (lib/jobs/status.ts officeGroup) has its own query, so years of finished
// jobs never push current work off the page. /jobs is the only way into /jobs/[id], where the
// office assigns crews and verifies actuals, so these groups are always complete:
//  - every scheduled and in-progress job, unscheduled first (a signed quote's new job has no
//    date yet), then by date;
//  - every completed job still awaiting verification: no actuals yet, or a row not verified.
// The history groups show the most recent RECENT_LIMIT jobs and how many there are in all,
// unless the office asks for all of one (?all=verified, ?all=cancelled):
//  - verified: completed, has actuals and every row verified (newest completion first);
//  - cancelled: newest first by updated_at (jobs have no cancelled_at; cancelling is normally
//    the last change to a job).
// Complete groups are read page by page: PostgREST returns at most its max-rows per request.
import type { JobStatus, OfficeGroup } from './status';

export const RECENT_LIMIT = 50;
/** Rows requested per page. Paging advances by rows received, so a lower server cap is safe. */
export const PAGE_SIZE = 1000;

export const HISTORY_GROUPS = ['verified', 'cancelled'] as const satisfies readonly OfficeGroup[];
export type HistoryGroup = (typeof HISTORY_GROUPS)[number];

export function isHistoryGroup(g: string): g is HistoryGroup {
  return (HISTORY_GROUPS as readonly string[]).includes(g);
}

/** The ?all= search param: the one history group to show in full, if any. */
export function parseShowAll(v: string | string[] | undefined): HistoryGroup | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s !== undefined && isHistoryGroup(s) ? s : null;
}

/**
 * Filters, in PostgREST terms. Every query embeds all of a job's actuals as `actuals`; a query
 * may embed them again under another alias only to filter on (`unverified`).
 *  - eq / in: on a jobs column;
 *  - unverifiedRows: the `unverified` embed keeps only rows with verified_at null;
 *  - isNull / notNull on an embed alias: the (filtered) embed is empty / not empty.
 */
export type ListFilter =
  | { op: 'eq'; column: 'status'; value: JobStatus }
  | { op: 'in'; column: 'status'; values: JobStatus[] }
  | { op: 'unverifiedRows' }
  | { op: 'isNull'; embed: EmbedAlias }
  | { op: 'notNull'; embed: EmbedAlias };

export type EmbedAlias = 'actuals' | 'unverified';

/** The extra select item behind the `unverified` alias (the filter keeps unverified rows only). */
export const UNVERIFIED_EMBED = 'unverified:job_actuals(id)';

export interface ListOrder {
  column: 'scheduled_start' | 'created_at' | 'completed_at' | 'updated_at' | 'id';
  ascending: boolean;
  nullsFirst: boolean;
}

export type ListQueryName = 'open' | 'awaiting_unverified' | 'awaiting_no_actuals' | 'verified' | 'cancelled';

export interface ListQuery {
  name: ListQueryName;
  /** The office groups its rows land in. */
  groups: readonly OfficeGroup[];
  /** Extra select items (aliases to filter on). */
  embeds: string[];
  filters: ListFilter[];
  order: ListOrder[];
  /** null: every row (paged). Otherwise the first `limit` rows, plus the total. */
  limit: number | null;
}

const asc = (column: ListOrder['column'], nullsFirst = false): ListOrder => ({ column, ascending: true, nullsFirst });
const desc = (column: ListOrder['column']): ListOrder => ({ column, ascending: false, nullsFirst: false });
// id last everywhere: paging needs a total order.
const NEWEST_COMPLETION = [desc('completed_at'), asc('id')];

export function officeListQueries(showAll: HistoryGroup | null = null): ListQuery[] {
  const recent = (g: HistoryGroup) => (showAll === g ? null : RECENT_LIMIT);
  return [
    {
      name: 'open',
      groups: ['in_progress', 'scheduled'],
      embeds: [],
      filters: [{ op: 'in', column: 'status', values: ['scheduled', 'in_progress'] }],
      order: [asc('scheduled_start', true), desc('created_at'), asc('id')],
      limit: null,
    },
    {
      name: 'awaiting_unverified',
      groups: ['awaiting_verification'],
      embeds: [UNVERIFIED_EMBED],
      filters: [
        { op: 'eq', column: 'status', value: 'completed' },
        { op: 'unverifiedRows' },
        { op: 'notNull', embed: 'unverified' },
      ],
      order: NEWEST_COMPLETION,
      limit: null,
    },
    {
      name: 'awaiting_no_actuals',
      groups: ['awaiting_verification'],
      embeds: [],
      filters: [
        { op: 'eq', column: 'status', value: 'completed' },
        { op: 'isNull', embed: 'actuals' },
      ],
      order: NEWEST_COMPLETION,
      limit: null,
    },
    {
      name: 'verified',
      groups: ['verified'],
      embeds: [UNVERIFIED_EMBED],
      filters: [
        { op: 'eq', column: 'status', value: 'completed' },
        { op: 'notNull', embed: 'actuals' },
        { op: 'unverifiedRows' },
        { op: 'isNull', embed: 'unverified' },
      ],
      order: NEWEST_COMPLETION,
      limit: recent('verified'),
    },
    {
      name: 'cancelled',
      groups: ['cancelled'],
      embeds: [],
      filters: [{ op: 'eq', column: 'status', value: 'cancelled' }],
      order: [desc('updated_at'), asc('id')],
      limit: recent('cancelled'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------

export interface RowPage {
  data: unknown[] | null;
  error: { message: string } | null;
  /** Rows matching the query in all (select with count: 'exact'), when the server sent it. */
  count: number | null;
}

/**
 * The first `limit` rows and the total, or (limit null) every row, page by page. Throws on a
 * failed request.
 */
export async function fetchRows(
  page: (from: number, to: number) => PromiseLike<RowPage>,
  limit: number | null,
  pageSize = PAGE_SIZE,
): Promise<{ rows: unknown[]; total: number }> {
  if (limit !== null) {
    const r = await page(0, limit - 1);
    if (r.error) throw new Error(r.error.message);
    const rows = r.data ?? [];
    return { rows, total: Math.max(r.count ?? rows.length, rows.length) };
  }
  const rows: unknown[] = [];
  let total: number | null = null;
  for (;;) {
    const r = await page(rows.length, rows.length + pageSize - 1);
    if (r.error) throw new Error(r.error.message);
    const data = r.data ?? [];
    rows.push(...data);
    total = r.count ?? total;
    const done = data.length === 0 || (total !== null ? rows.length >= total : data.length < pageSize);
    if (done) return { rows, total: Math.max(total ?? rows.length, rows.length) };
  }
}

/** Rows of several queries as one list, each job once (offset paging can repeat a row). */
export function uniqueById<T extends { id: string }>(lists: ReadonlyArray<readonly T[]>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const row of list) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

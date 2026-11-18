// Business dates for jobs. "Today", "recently completed" and every date a person reads are in
// the store's time zone (locations.time_zone), whatever the time zone of the server or the phone.
// Pure (callers pass `now` and the time zone), so it is testable across DST switches.

const partsFmts = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = partsFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFmts.set(tz, f);
  }
  return f;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDate(at: Date | string): Date {
  return typeof at === 'string' ? new Date(at) : at;
}

function wallClock(at: Date, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = partsFmt(tz).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isYmd(s: string): boolean {
  const m = YMD.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function parseYmd(ymd: string): [number, number, number] {
  if (!isYmd(ymd)) throw new RangeError(`Not a YYYY-MM-DD date: ${ymd}`);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** The calendar date (YYYY-MM-DD) of an instant in time zone `tz`. */
export function localDate(at: Date | string, tz: string): string {
  const w = wallClock(toDate(at), tz);
  return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
}

/** Wall-clock time in `tz` minus UTC, in minutes (New York: -300 in winter, -240 in summer). */
export function offsetMinutes(at: Date, tz: string): number {
  const w = wallClock(at, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant calendar day `ymd` begins in time zone `tz`. */
export function startOfDay(ymd: string, tz: string): Date {
  const [y, m, d] = parseYmd(ymd);
  const utcMidnight = Date.UTC(y, m - 1, d);
  let t = utcMidnight - offsetMinutes(new Date(utcMidnight), tz) * 60_000;
  // The offset at local midnight can differ from the one at UTC midnight on a DST switch day.
  t = utcMidnight - offsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

/** `ymd` plus `days` calendar days. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = parseYmd(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole calendar days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parseYmd(a);
  const [by, bm, bd] = parseYmd(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * Start of the day `days` days before today in time zone `tz`, as an ISO instant: the lower bound
 * for "completed in the last N days" (today counts as day 0).
 */
export function recentCutoffIso(now: Date, days: number, tz: string): string {
  return startOfDay(addDays(localDate(now, tz), -days), tz).toISOString();
}

// A date column (scheduled_start) has no time zone: format it as the calendar date it names.
const dateOnlyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const dateOnlyYearFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** "Tue, Oct 20" for a YYYY-MM-DD date (the year is added when it differs from `today`'s). Anything else is shown as is. */
export function formatYmd(ymd: string, today?: string): string {
  if (!isYmd(ymd)) return ymd;
  const [y] = parseYmd(ymd);
  const at = new Date(`${ymd}T00:00:00Z`);
  return today && Number(today.slice(0, 4)) !== y ? dateOnlyYearFmt.format(at) : dateOnlyFmt.format(at);
}

/** "Today", "Tomorrow", "Yesterday", else "Tue, Oct 20". */
export function dayLabel(ymd: string, today: string): string {
  if (!isYmd(ymd) || !isYmd(today)) return formatYmd(ymd);
  const diff = daysBetween(today, ymd);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return formatYmd(ymd, today);
}

const dateTimeFmts = new Map<string, Intl.DateTimeFormat>();

/** "Oct 20, 3:45 PM" in time zone `tz`. */
export function formatDateTime(at: Date | string, tz: string): string {
  let f = dateTimeFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    dateTimeFmts.set(tz, f);
  }
  return f.format(toDate(at));
}

/** "October 20, 2026" in time zone `tz` (quotes, emails). */
export function formatLongDate(at: Date | string, tz: string): string {
  return toDate(at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
}

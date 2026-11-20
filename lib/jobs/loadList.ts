// The crew's load list: what to put on the truck at the shop, from the signed scope of the jobs a
// crew starts that day, so nobody drives back for a forgotten bag (the owner: "materials get
// miscalculated on what to bring, then the owner has to drive to the job site").
//
// Owner decision: the list brings exactly what the estimate calculated (the estimate already holds
// the waste factor), rounded UP to whole units, with no extra percentage. Every material line of
// every area of every job that starts that day is summed by material name and unit first, then
// rounded up once (two areas of 31.4 bags load 63 bags, not 64). Labor and removal lines are hours,
// not things to load, and are left out, and so is a material line whose quantity the estimator set
// to 0 (nothing of it is installed; the engine keeps the line so the quantity can be changed back).
// A day is the job's scheduled start date in the business time zone (lib/jobs/dates.ts); a job
// planned over several days loads on its first day only.
//
// A tick on the phone holds the amount it was ticked at, so a material ticked at 20 bags is not
// "loaded" once the day says 50 (a job moved onto the day after the crew ticked it).
//
// Built from the crew app's own copy of its jobs (crew_job_view: quantities and words only, never a
// price), so it works with no signal. Pure.
import { PRODUCTS, type ProductCode, type ProductUnit } from '@/lib/pricing';
import { num } from '@/lib/format';
import { withoutPrices, type CrewJob } from './crew';
import { addDays, daysBetween, isYmd } from './dates';
import type { JobStatus } from './status';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What the load list reads of a crew job (CrewJob, or a job cached before notes existed). */
export type LoadSourceJob = Pick<CrewJob, 'jobId' | 'status' | 'scheduledStart' | 'scheduledDays' | 'address' | 'customer' | 'areas'> & {
  notes?: CrewJob['notes'];
};

/** One material to load: the sum over areas and jobs, rounded up to a whole unit. */
export interface LoadLine {
  /** Stable key of the line on the phone: the same material, name and unit every day (a tick also holds its amount). */
  key: string;
  product: ProductCode;
  name: string;
  unit: ProductUnit | null;
  /** Whole units to load; null when no area of the scope gives a quantity. */
  qty: number | null;
  /** `qty` is what the areas with a quantity add up to, and some other area has this material with none. */
  plusUnknown: boolean;
  /** The jobs that need it, in the day's order. */
  jobIds: string[];
}

/** Something to bring that is not a material: the owner's always-bring list, the blower door kit. */
export interface EquipmentLine {
  key: string;
  text: string;
}

/** The estimator's notes (on the estimate) and the office's (on the job), as the crew reads them. */
export interface CrewNotes {
  estimator: string | null;
  office: string | null;
}

/** A job on a day's list: who and where, which day of how many, and its notes. */
export interface LoadJob {
  jobId: string;
  status: JobStatus;
  customer: string;
  street: string;
  /** Day `day` of `days` (1 of 1 for a one-day job). */
  day: number;
  days: number;
  notes: CrewNotes;
}

export interface DayLoad {
  date: string; // YYYY-MM-DD, business time zone
  /** Jobs that start this day: their materials are on `lines`. */
  jobs: LoadJob[];
  lines: LoadLine[];
  /** Jobs still on site this day (day 2 or later): loaded on their first day, so no materials here. */
  continuing: LoadJob[];
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** Statuses a crew loads for: not started yet, or started. */
const LOADS: ReadonlySet<JobStatus> = new Set(['scheduled', 'in_progress']);

/** How many days a job is planned over: 2.5 planned days is a 3-day job; none or less than one is one day. */
export function jobDays(job: Pick<LoadSourceJob, 'scheduledDays'>): number {
  const d = job.scheduledDays;
  return d !== null && Number.isFinite(d) && d > 1 ? Math.ceil(d - 1e-9) : 1;
}

/** Which day of the job `date` is (1 = its scheduled start), or null when the job is not on site that day. */
export function dayOfJob(job: Pick<LoadSourceJob, 'scheduledStart' | 'scheduledDays'>, date: string): number | null {
  if (!job.scheduledStart || !isYmd(job.scheduledStart) || !isYmd(date)) return null;
  const day = daysBetween(job.scheduledStart, date) + 1;
  return day >= 1 && day <= jobDays(job) ? day : null;
}

/** The YYYY-MM-DD dates a load list is shown for: today and tomorrow (business time zone). */
export function loadDates(today: string): { today: string; tomorrow: string } {
  return { today, tomorrow: addDays(today, 1) };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Sums before rounding can land a hair above a whole number (0.1 + 0.2): read them at 1e-6. */
const roundUp = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e6);

const lineKey = (product: ProductCode, name: string, unit: ProductUnit | null) =>
  `m:${product}|${unit ?? ''}|${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/**
 * Every material line of these jobs' scopes, summed by material and unit, then rounded up. A line
 * with a quantity of 0 (or less) installs nothing and is left out; a line with no quantity marks its
 * material as having an amount the estimate does not give (on its own, or on top of the others' sum).
 */
function sumMaterials(jobs: readonly LoadSourceJob[]): LoadLine[] {
  const acc = new Map<string, Omit<LoadLine, 'qty' | 'plusUnknown'> & { sum: number | null; unknown: boolean; order: number }>();
  for (const job of jobs) {
    for (const area of job.areas) {
      for (const line of area.scope) {
        if (line.kind !== 'material') continue;
        const qty = line.qty !== null && Number.isFinite(line.qty) ? line.qty : null;
        if (qty !== null && qty <= 0) continue;
        const name = withoutPrices(line.description).replace(/\s+/g, ' ').trim() || 'Material';
        const key = lineKey(line.product, name, line.unit);
        let row = acc.get(key);
        if (!row) {
          row = { key, product: line.product, name, unit: line.unit, jobIds: [], sum: null, unknown: false, order: acc.size };
          acc.set(key, row);
        }
        if (qty === null) row.unknown = true;
        else row.sum = (row.sum ?? 0) + qty;
        if (!row.jobIds.includes(job.jobId)) row.jobIds.push(job.jobId);
      }
    }
  }
  return [...acc.values()]
    .sort(
      (a, b) =>
        PRODUCTS.indexOf(a.product) - PRODUCTS.indexOf(b.product) ||
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
        (a.unit ?? '').localeCompare(b.unit ?? '') ||
        a.order - b.order,
    )
    .map(({ key, product, name, unit, jobIds, sum, unknown }) => ({
      key,
      product,
      name,
      unit,
      qty: sum === null ? null : roundUp(sum),
      plusUnknown: sum !== null && unknown,
      jobIds,
    }));
}

/** One job's notes; a job cached on the phone before notes existed has none. */
export function notesOf(job: Pick<LoadSourceJob, 'notes'>): CrewNotes {
  return { estimator: job.notes?.estimator ?? null, office: job.notes?.office ?? null };
}

const asLoadJob = (job: LoadSourceJob, day: number): LoadJob => ({
  jobId: job.jobId,
  status: job.status,
  customer: job.customer.name,
  street: job.address.street,
  day,
  days: jobDays(job),
  notes: notesOf(job),
});

/** One job's load list ("What to bring" on its page): all of its materials, whatever the day. */
export function jobLoadList(job: LoadSourceJob): LoadLine[] {
  return sumMaterials([job]);
}

/**
 * A day's load list: the materials of every job that starts on `date` (scheduled or in progress),
 * summed across areas and jobs and rounded up once, with each job's label and notes. Jobs are in
 * the order a crew does them: in progress first, then by customer and street, so the list reads the
 * same on every phone.
 */
export function dayLoadList(jobs: readonly LoadSourceJob[], date: string): DayLoad {
  const onSite = jobs.filter((j) => LOADS.has(j.status)).map((j) => ({ job: j, day: dayOfJob(j, date) }));
  const order = (a: LoadSourceJob, b: LoadSourceJob) =>
    Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
    a.customer.name.localeCompare(b.customer.name, 'en', { sensitivity: 'base' }) ||
    a.address.street.localeCompare(b.address.street, 'en', { sensitivity: 'base' }) ||
    a.jobId.localeCompare(b.jobId);
  const starting = onSite.filter((x) => x.day === 1).map((x) => x.job).sort(order);
  const continuing = onSite.filter((x) => x.day !== null && x.day > 1).sort((a, b) => order(a.job, b.job));
  return {
    date,
    jobs: starting.map((j) => asLoadJob(j, 1)),
    lines: sumMaterials(starting),
    continuing: continuing.map((x) => asLoadJob(x.job, x.day!)),
  };
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

/** The longest always-bring list and item the owner can save (a list to tick off on a phone). */
export const ALWAYS_BRING_MAX_ITEMS = 40;
export const ALWAYS_BRING_MAX_LENGTH = 120;

const cleanItem = (s: string) => withoutPrices(s.replace(/\s+/g, ' ').trim());

/**
 * The owner's always-bring list from app_settings.load_list ({"always_bring": [...]}): trimmed,
 * blanks and repeats left out, never a price. Anything else reads as no list.
 */
export function parseAlwaysBring(value: unknown): string[] {
  const items = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { always_bring?: unknown }).always_bring : null;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const item = cleanItem(raw).slice(0, ALWAYS_BRING_MAX_LENGTH);
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
    if (out.length === ALWAYS_BRING_MAX_ITEMS) break;
  }
  return out;
}

/**
 * The Pricing page's "Always bring" box (one item per line) as the setting's list. Blank lines and
 * repeats are dropped; an empty box saves an empty list.
 */
export function alwaysBringFromText(text: string): { ok: true; items: string[] } | { ok: false; error: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const long = lines.find((l) => l.length > ALWAYS_BRING_MAX_LENGTH);
  if (long) return { ok: false, error: `Always bring: keep each item under ${ALWAYS_BRING_MAX_LENGTH} characters ("${long.slice(0, 30)}…").` };
  const seen = new Set<string>();
  const items = lines.filter((l) => !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
  if (items.length > ALWAYS_BRING_MAX_ITEMS) return { ok: false, error: `Always bring: at most ${ALWAYS_BRING_MAX_ITEMS} items (there are ${items.length}).` };
  return { ok: true, items };
}

/** The always-bring items as lines to tick off. */
export function alwaysBringLines(items: readonly string[]): EquipmentLine[] {
  return items.map((text) => ({ key: `a:${text.toLowerCase()}`, text }));
}

/**
 * True when a job's blower door test-out is still to do: its estimate has a test-in and the job
 * has no test-out yet (the readings the phone has: the server's copy and its own unsent ones).
 */
export function needsBlowerDoorKit(readings: ReadonlyArray<{ kind: 'test_in' | 'test_out' }>): boolean {
  return readings.some((r) => r.kind === 'test_in') && !readings.some((r) => r.kind === 'test_out');
}

/** "Blower door kit (test-out at 12 Elkton Rd)": one per job that still needs its test-out. */
export function blowerDoorKitLine(job: Pick<LoadJob, 'jobId' | 'street'>): EquipmentLine {
  return { key: `bd:${job.jobId}`, text: `Blower door kit (test-out at ${job.street.trim() || 'the job'})` };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const UNIT_ONE: Record<ProductUnit, string> = { board_ft: 'board ft', bag: 'bag', sqft: 'sq ft', linear_ft: 'linear ft', hour: 'hour', each: 'each' };
const UNIT_MANY: Record<ProductUnit, string> = { board_ft: 'board ft', bag: 'bags', sqft: 'sq ft', linear_ft: 'linear ft', hour: 'hours', each: 'each' };

/** What a material line says with its sum when some area gives no quantity for it. */
export const PLUS_UNKNOWN = 'Plus an amount not on the estimate';

/**
 * "63 bags", "1 bag", "2,400 board ft"; "Amount not on the estimate" with no quantity; "32 bags,
 * plus an amount not on the estimate" when some area gives one and another none.
 */
export function qtyText(line: Pick<LoadLine, 'qty' | 'unit'> & { plusUnknown?: boolean }): string {
  if (line.qty === null) return 'Amount not on the estimate';
  const unit = line.unit ? (line.qty === 1 ? UNIT_ONE : UNIT_MANY)[line.unit] : '';
  return `${num(line.qty)}${unit ? ` ${unit}` : ''}${line.plusUnknown ? `, ${PLUS_UNKNOWN.toLowerCase()}` : ''}`;
}

/** "Day 1 of 3", or null for a one-day job. */
export function dayText(job: Pick<LoadJob, 'day' | 'days'>): string | null {
  return job.days > 1 ? `Day ${job.day} of ${job.days}` : null;
}

// ---------------------------------------------------------------------------
// Ticks (which lines are loaded), kept on the phone per day
// ---------------------------------------------------------------------------

/** The amount a material was ticked off at (its line's quantity then). */
export interface AmountTick {
  qty: number | null;
  plusUnknown: boolean;
}

/** What a tick holds: the amount for a material, true for a thing to bring (the always-bring list, a kit). */
export type Tick = AmountTick | true;

/** The phone's record of what is loaded on one day: line key -> its tick. */
export type Ticks = Record<string, Tick>;

const isMaterial = (line: LoadLine | EquipmentLine): line is LoadLine => 'qty' in line;

/** A stored amount tick as it should be (the phone's store can hold anything: an older build's `true`, a broken row). */
function amountTick(stored: unknown): AmountTick | null {
  if (stored === null || typeof stored !== 'object') return null;
  const { qty, plusUnknown } = stored as Partial<AmountTick>;
  if (!(qty === null || (typeof qty === 'number' && Number.isFinite(qty))) || typeof plusUnknown !== 'boolean') return null;
  return { qty, plusUnknown };
}

/** What ticking this line stores: a material's amount right now, or true. */
export function tickOf(line: LoadLine | EquipmentLine): Tick {
  return isMaterial(line) ? { qty: line.qty, plusUnknown: line.plusUnknown } : true;
}

const sameTick = (stored: unknown, tick: Tick): boolean => {
  if (tick === true) return stored === true;
  const t = amountTick(stored);
  return t !== null && t.qty === tick.qty && t.plusUnknown === tick.plusUnknown;
};

/** True when the line is loaded: ticked, and a material at the amount it says now. */
export function isTicked(ticks: Ticks, line: LoadLine | EquipmentLine): boolean {
  return sameTick(ticks[line.key], tickOf(line));
}

/**
 * The amount a material was ticked at when it says another amount now (the day's jobs changed after
 * the tick), else null. The row shows it unticked, with what changed.
 */
export function tickedBefore(ticks: Ticks, line: LoadLine): AmountTick | null {
  const t = amountTick(ticks[line.key]);
  return t && !sameTick(t, tickOf(line)) ? t : null;
}

const amountWords = (t: Pick<LoadLine, 'qty' | 'unit' | 'plusUnknown'>) => (t.qty === null ? 'an amount not on the estimate' : qtyText(t));

/** "Changed after it was ticked: was 20 bags, now 50 bags." */
export function changedText(was: AmountTick, line: LoadLine): string {
  return `Changed after it was ticked: was ${amountWords({ ...was, unit: line.unit })}, now ${amountWords(line)}.`;
}

/** How many of the day's lines are loaded (a material at the amount it says now), of how many. */
export function loadProgress(lines: readonly LoadLine[], equipment: readonly EquipmentLine[], ticks: Ticks): { done: number; total: number } {
  const all = [...lines, ...equipment];
  return { done: all.filter((l) => isTicked(ticks, l)).length, total: all.length };
}

/** The key the crew app keeps a day's ticks under (per person, per day: a new day starts empty). */
export const ticksKey = (ownerId: string, date: string) => `load:${ownerId}:${date}`;

/**
 * Ticks with one line flipped: a line loaded at `tick` (what ticking it stores now, tickOf) is
 * unticked; anything else (unticked, or ticked at another amount) is ticked at `tick`.
 */
export function toggleTick(ticks: Ticks, key: string, tick: Tick): Ticks {
  const next = { ...ticks };
  if (sameTick(next[key], tick)) delete next[key];
  else next[key] = tick;
  return next;
}

/** Stored tick keys of days before `oldest` (to drop: a day's ticks are only for that day and the next). */
export function staleTickKeys(keys: readonly string[], ownerId: string, oldest: string): string[] {
  const prefix = `load:${ownerId}:`;
  return keys.filter((k) => k.startsWith(prefix) && k.slice(prefix.length) < oldest);
}

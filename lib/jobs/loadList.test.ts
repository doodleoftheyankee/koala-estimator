import { describe, expect, it } from 'vitest';
import type { CrewArea, ScopeLine } from './crew';
import {
  ALWAYS_BRING_MAX_ITEMS,
  alwaysBringFromText,
  alwaysBringLines,
  blowerDoorKitLine,
  dayLoadList,
  dayOfJob,
  dayText,
  jobDays,
  jobLoadList,
  loadDates,
  needsBlowerDoorKit,
  notesOf,
  parseAlwaysBring,
  qtyText,
  staleTickKeys,
  ticksKey,
  toggleTick,
  type LoadSourceJob,
} from './loadList';

const TODAY = '2026-11-20';
const TOMORROW = '2026-11-21';
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const mat = (product: ScopeLine['product'], description: string, qty: number | null, unit: ScopeLine['unit']): ScopeLine => ({
  product,
  kind: 'material',
  description,
  qty,
  unit,
  hours: null,
});
const labor = (product: ScopeLine['product'], hours: number): ScopeLine => ({ product, kind: 'labor', description: `Install ${product}`, qty: hours, unit: 'hour', hours });
const removal = (hours: number): ScopeLine => ({ product: 'removal', kind: 'removal', description: 'Removal of old insulation', qty: 900, unit: 'sqft', hours });

function area(name: string, scope: ScopeLine[]): CrewArea {
  return { areaId: id(), name, jobType: 'attic', sqft: 1000, accessLevel: 'moderate', removalNeeded: false, prepNotes: null, hazards: [], hazardDisposition: null, scope };
}

function job(over: Partial<LoadSourceJob> = {}): LoadSourceJob {
  return {
    jobId: id(),
    status: 'scheduled',
    scheduledStart: TODAY,
    scheduledDays: 1,
    address: { street: '12 Shop Ln', city: 'Springfield', zip: '62701', lat: null, lng: null },
    customer: { name: 'Pat Lee', phone: null },
    areas: [area('Attic', [mat('cellulose', 'Blown cellulose', 31.4, 'bag'), labor('cellulose', 8)])],
    notes: { estimator: 'Gate code 4411', office: null },
    ...over,
  };
}

describe('the load list sums first, then rounds up once (owner decision: exactly what the estimate calculated)', () => {
  it('two areas of 31.4 bags load 63 bags, not 64', () => {
    const j = job({ areas: [area('Attic', [mat('cellulose', 'Blown cellulose', 31.4, 'bag')]), area('Garage attic', [mat('cellulose', 'Blown cellulose', 31.4, 'bag')])] });
    const lines = jobLoadList(j);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Blown cellulose', unit: 'bag', qty: 63, jobIds: [j.jobId] });
    expect(qtyText(lines[0]!)).toBe('63 bags');
  });

  it('a sum across jobs of the same day is rounded once too, and adds no extra percentage', () => {
    const a = job({ customer: { name: 'Ann Able', phone: null }, areas: [area('Attic', [mat('cellulose', 'Blown cellulose', 20.2, 'bag')])] });
    const b = job({ customer: { name: 'Bo Baker', phone: null }, areas: [area('Attic', [mat('cellulose', 'Blown cellulose', 10.3, 'bag')])] });
    const day = dayLoadList([b, a], TODAY);
    expect(day.lines).toEqual([expect.objectContaining({ name: 'Blown cellulose', qty: 31, jobIds: [a.jobId, b.jobId] })]);
    // A whole number stays as it is: nothing is added.
    expect(jobLoadList(job({ areas: [area('A', [mat('cellulose', 'Blown cellulose', 40, 'bag')])] }))[0]!.qty).toBe(40);
  });

  it('a sum a hair above a whole number from floating point is not rounded up to the next one', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in floating point; ten areas of 0.1 + 0.2 bags are 3 bags.
    const areas = Array.from({ length: 10 }, (_, i) => area(`A${i}`, [mat('cellulose', 'Blown cellulose', 0.1, 'bag'), mat('cellulose', 'Blown cellulose', 0.2, 'bag')]));
    expect(Math.ceil(areas.flatMap((a) => a.scope).reduce((s, l) => s + l.qty!, 0))).toBe(4); // 3.0000000000000013
    expect(jobLoadList(job({ areas }))[0]!.qty).toBe(3);
  });

  it('keeps units and materials apart: the same name in another unit is another line', () => {
    const j = job({
      areas: [
        area('Attic', [mat('cellulose', 'Blown cellulose', 10.5, 'bag'), mat('air_sealing', 'Air sealing', 1200, 'sqft')]),
        area('Walls', [mat('cellulose', 'Blown cellulose', 3, 'linear_ft'), mat('cellulose', 'Dense-pack cellulose', 7.2, 'bag')]),
      ],
    });
    expect(jobLoadList(j).map((l) => `${l.name}|${l.unit}|${l.qty}`)).toEqual([
      'Blown cellulose|bag|11',
      'Blown cellulose|linear_ft|3',
      'Dense-pack cellulose|bag|8',
      'Air sealing|sqft|1200',
    ]);
  });

  it('merges the same material however its name is spaced or capitalised', () => {
    const j = job({ areas: [area('A', [mat('batts', 'Fiberglass batt R-30', 4.5, 'bag')]), area('B', [mat('batts', 'fiberglass  batt r-30', 4.5, 'bag')])] });
    expect(jobLoadList(j)).toEqual([expect.objectContaining({ name: 'Fiberglass batt R-30', qty: 9 })]);
  });

  it('leaves labor and removal lines out (hours are not loaded on a truck)', () => {
    const j = job({ areas: [area('A', [labor('cellulose', 12), removal(6), mat('cellulose', 'Blown cellulose', 5, 'bag'), labor('air_sealing', 3)])] });
    expect(jobLoadList(j)).toEqual([expect.objectContaining({ name: 'Blown cellulose', qty: 5 })]);
    expect(jobLoadList(job({ areas: [area('A', [labor('cellulose', 12)])] }))).toEqual([]);
  });

  it('a material with no quantity on the estimate is still listed, and says so', () => {
    const lines = jobLoadList(job({ areas: [area('A', [mat('air_sealing', 'Foam sealant', null, 'each')]), area('B', [mat('cellulose', 'Blown cellulose', 0, 'bag')])] }));
    expect(lines.map((l) => [l.name, l.qty])).toEqual([
      ['Blown cellulose', null],
      ['Foam sealant', null],
    ]);
    expect(qtyText(lines[1]!)).toBe('Amount not on the estimate');
    expect(qtyText({ qty: 1, unit: 'bag' })).toBe('1 bag');
    expect(qtyText({ qty: 2400, unit: 'board_ft' })).toBe('2,400 board ft');
    expect(qtyText({ qty: 3, unit: null })).toBe('3');
  });

  it('never carries a price: no money field, and a price in a material name is taken out', () => {
    const j = job({ areas: [area('A', [mat('ocsf', 'Open-cell set (~$1,800/set at full yield, per board ft)', 950.4, 'board_ft')])] });
    const lines = jobLoadList(j);
    expect(lines[0]!.name).toBe('Open-cell set');
    expect(Object.keys(lines[0]!).sort()).toEqual(['jobIds', 'key', 'name', 'product', 'qty', 'unit']);
    const day = dayLoadList([j], TODAY);
    expect(JSON.stringify(day)).not.toMatch(/\$|price|cost/i);
  });

  it('sorts by product (spray foam, cellulose, fiberglass, batts, air sealing), then by name, the same every time', () => {
    const j = job({
      areas: [
        area('A', [mat('air_sealing', 'Air sealing', 100, 'sqft'), mat('cellulose', 'Loose cellulose', 2, 'bag'), mat('batts', 'Batt R-13', 3, 'bag')]),
        area('B', [mat('cellulose', 'Blown cellulose', 4, 'bag'), mat('ocsf', 'Open-cell set', 500, 'board_ft'), mat('ccsf', 'Closed-cell set', 200, 'board_ft')]),
      ],
    });
    const names = jobLoadList(j).map((l) => l.name);
    expect(names).toEqual(['Open-cell set', 'Closed-cell set', 'Blown cellulose', 'Loose cellulose', 'Batt R-13', 'Air sealing']);
    expect(jobLoadList({ ...j, areas: [...j.areas].reverse() }).map((l) => l.name)).toEqual(names);
    // The tick key is the same for the same material on any day.
    expect(jobLoadList(j)[2]!.key).toBe('m:cellulose|bag|blown cellulose');
  });
});

describe('a day: the jobs that start then, a multi-day job on its first day only', () => {
  it("today's list has today's jobs; tomorrow's has tomorrow's", () => {
    const today = job({ customer: { name: 'Pat Lee', phone: null } });
    const tomorrow = job({ customer: { name: 'Kim Day', phone: null }, scheduledStart: TOMORROW, areas: [area('A', [mat('fiberglass_blown', 'Blown fiberglass', 12.1, 'bag')])] });
    const { today: t, tomorrow: m } = loadDates(TODAY);
    expect(m).toBe(TOMORROW);
    expect(dayLoadList([today, tomorrow], t).lines.map((l) => l.name)).toEqual(['Blown cellulose']);
    expect(dayLoadList([today, tomorrow], m).lines).toEqual([expect.objectContaining({ name: 'Blown fiberglass', qty: 13 })]);
    expect(dayLoadList([today, tomorrow], m).jobs.map((j) => j.customer)).toEqual(['Kim Day']);
  });

  it('a three-day job loads on day 1 only, says "day 1 of 3", and shows as continuing after', () => {
    const j = job({ scheduledDays: 2.5 });
    expect(jobDays(j)).toBe(3);
    const d1 = dayLoadList([j], TODAY);
    expect(d1.jobs).toEqual([expect.objectContaining({ jobId: j.jobId, day: 1, days: 3 })]);
    expect(dayText(d1.jobs[0]!)).toBe('Day 1 of 3');
    expect(d1.lines[0]!.qty).toBe(32);
    const d2 = dayLoadList([j], TOMORROW);
    expect(d2.lines).toEqual([]);
    expect(d2.jobs).toEqual([]);
    expect(d2.continuing).toEqual([expect.objectContaining({ jobId: j.jobId, day: 2, days: 3 })]);
    expect(dayLoadList([j], '2026-11-23').continuing).toEqual([]);
    expect(dayOfJob(j, '2026-11-22')).toBe(3);
    expect(dayOfJob(j, '2026-11-19')).toBeNull();
  });

  it('a one-day job (or no planned days) is "day 1 of 1" with no day words', () => {
    expect(jobDays({ scheduledDays: null })).toBe(1);
    expect(jobDays({ scheduledDays: 0.5 })).toBe(1);
    expect(jobDays({ scheduledDays: 1 })).toBe(1);
    expect(jobDays({ scheduledDays: 2 })).toBe(2);
    expect(dayText({ day: 1, days: 1 })).toBeNull();
  });

  it('leaves out unscheduled, completed and cancelled jobs', () => {
    const jobs = [job({ scheduledStart: null }), job({ status: 'completed' }), job({ status: 'cancelled' }), job({ scheduledStart: 'not a date' })];
    expect(dayLoadList(jobs, TODAY)).toEqual({ date: TODAY, jobs: [], lines: [], continuing: [] });
    expect(dayOfJob(job(), 'nope')).toBeNull();
  });

  it('orders jobs in progress first, then by customer and street, with their labels and notes', () => {
    const a = job({ customer: { name: 'Zed Last', phone: null }, status: 'in_progress', notes: { estimator: null, office: 'Office: park on the street' } });
    const b = job({ customer: { name: 'Ann First', phone: null }, address: { street: '9 B St', city: 'X', zip: '1', lat: null, lng: null } });
    const c = job({ customer: { name: 'Ann First', phone: null }, address: { street: '1 A St', city: 'X', zip: '1', lat: null, lng: null }, notes: undefined });
    const day = dayLoadList([b, c, a], TODAY);
    expect(day.jobs.map((j) => `${j.customer} · ${j.street}`)).toEqual(['Zed Last · 12 Shop Ln', 'Ann First · 1 A St', 'Ann First · 9 B St']);
    expect(day.jobs[0]!.notes).toEqual({ estimator: null, office: 'Office: park on the street' });
    // A job a phone cached before notes existed has none.
    expect(day.jobs[1]!.notes).toEqual({ estimator: null, office: null });
    expect(notesOf({})).toEqual({ estimator: null, office: null });
  });
});

describe('what every crew brings', () => {
  it('reads the owner list from the setting: trimmed, no blanks or repeats, never a price', () => {
    expect(parseAlwaysBring({ always_bring: ['  Ladders ', 'ladders', '', 'Tarps ($20 each)', 42, 'Respirators'] })).toEqual(['Ladders', 'Tarps', 'Respirators']);
    expect(parseAlwaysBring(null)).toEqual([]);
    expect(parseAlwaysBring([])).toEqual([]);
    expect(parseAlwaysBring({ always_bring: 'Ladders' })).toEqual([]);
    expect(parseAlwaysBring({ always_bring: Array.from({ length: 60 }, (_, i) => `Item ${i}`) })).toHaveLength(ALWAYS_BRING_MAX_ITEMS);
  });

  it('the Pricing box saves one item per line', () => {
    expect(alwaysBringFromText('Ladders\r\n\n  Tarps   and drop cloths \nladders\n')).toEqual({ ok: true, items: ['Ladders', 'Tarps and drop cloths'] });
    expect(alwaysBringFromText('')).toEqual({ ok: true, items: [] });
    const long = alwaysBringFromText('x'.repeat(121));
    expect(long.ok).toBe(false);
    const many = alwaysBringFromText(Array.from({ length: 41 }, (_, i) => `Item ${i}`).join('\n'));
    expect(many).toEqual({ ok: false, error: 'Always bring: at most 40 items (there are 41).' });
  });

  it('turns the list into lines to tick off', () => {
    expect(alwaysBringLines(['Ladders'])).toEqual([{ key: 'a:ladders', text: 'Ladders' }]);
  });

  it('adds the blower door kit for a job with a test-in and no test-out yet', () => {
    expect(needsBlowerDoorKit([{ kind: 'test_in' }])).toBe(true);
    expect(needsBlowerDoorKit([{ kind: 'test_in' }, { kind: 'test_out' }])).toBe(false);
    expect(needsBlowerDoorKit([])).toBe(false);
    expect(needsBlowerDoorKit([{ kind: 'test_out' }])).toBe(false);
    expect(blowerDoorKitLine({ jobId: 'j1', street: '12 Elkton Rd' })).toEqual({ key: 'bd:j1', text: 'Blower door kit (test-out at 12 Elkton Rd)' });
    expect(blowerDoorKitLine({ jobId: 'j1', street: ' ' }).text).toBe('Blower door kit (test-out at the job)');
  });
});

describe('ticks on the phone: per person and day, a new day starts empty', () => {
  it('flips one line at a time', () => {
    const t = toggleTick({}, 'm:cellulose|bag|blown cellulose');
    expect(t).toEqual({ 'm:cellulose|bag|blown cellulose': true });
    expect(toggleTick(t, 'm:cellulose|bag|blown cellulose')).toEqual({});
  });

  it('keys by person and date, and finds the days to drop', () => {
    expect(ticksKey('u1', TODAY)).toBe('load:u1:2026-11-20');
    const keys = [ticksKey('u1', '2026-11-18'), ticksKey('u1', '2026-11-19'), ticksKey('u1', TODAY), ticksKey('u1', TOMORROW), ticksKey('u2', '2026-11-01'), 'profile'];
    expect(staleTickKeys(keys, 'u1', TODAY)).toEqual(['load:u1:2026-11-18', 'load:u1:2026-11-19']);
  });
});

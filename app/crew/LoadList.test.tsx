// The crew app's Load list, rendered as it first paints (before the phone's ticks and the owner's
// list come out of IndexedDB): today's materials summed and rounded up, each a 56 px box to tick
// with gloves, the jobs with their notes, and never a price.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CrewJob, ScopeLine } from '@/lib/jobs/crew';
import { alwaysBringLines, dayLoadList, type Ticks } from '@/lib/jobs/loadList';
import type { LocalJob } from '@/lib/offline/crewDb';
import { DayBody, LoadList } from './LoadList';

const TODAY = '2026-11-20';

function localJob(over: Partial<CrewJob>): LocalJob {
  const job: CrewJob = {
    jobId: '00000000-0000-4000-8000-000000000001',
    status: 'scheduled',
    scheduledStart: TODAY,
    scheduledDays: 2,
    startedAt: null,
    completedAt: null,
    address: { street: '7 Loading Dock Rd', city: 'Springfield', zip: '62701', lat: null, lng: null },
    customer: { name: 'Dana Loader', phone: null },
    signedTier: 'better',
    areas: [1, 2].map((n) => ({
      areaId: `00000000-0000-4000-8000-00000000010${n}`,
      name: `Attic ${n}`,
      jobType: 'attic' as const,
      sqft: 1000,
      accessLevel: 'moderate' as const,
      removalNeeded: false,
      prepNotes: null,
      hazards: [],
      hazardDisposition: null,
      scope: [
        { product: 'cellulose' as const, kind: 'material' as const, description: 'Blown cellulose', qty: 31.4, unit: 'bag' as const, hours: null },
        { product: 'cellulose' as const, kind: 'labor' as const, description: 'Install cellulose', qty: 9, unit: 'hour' as const, hours: 9 },
      ],
    })),
    actuals: [],
    verified: false,
    notes: { estimator: 'Gate code 4411.\nDog in the yard.', office: 'Park on the street.' },
    ...over,
  };
  return { id: job.jobId, ownerId: 'u1', job, fetchedAt: '2026-11-20T12:00:00Z' };
}

const render = (jobs: LocalJob[]) =>
  renderToStaticMarkup(createElement(LoadList, { ownerId: 'u1', jobs, today: TODAY, online: false, onOpen: () => {} }));

describe('crew Load list', () => {
  it("shows today's materials added up, then rounded up once, as boxes to tick", () => {
    const html = render([localJob({})]);
    expect(html).toContain('Load list');
    expect(html).toContain('Blown cellulose');
    expect(html).toContain('63 bags'); // 31.4 + 31.4 = 62.8, not 32 + 32
    expect(html).not.toContain('64 bags');
    expect(html).not.toContain('Install cellulose');
    const box = /<button[^>]*role="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
    expect(box).toContain('aria-checked="false"');
    expect(box).toMatch(/min-h-14/); // 56 px, over the 44 px floor
    expect(html).toContain('0 of 1 loaded');
  });

  it('heads each job with its customer, street, day of the job and both notes', () => {
    const html = render([localJob({})]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(html).toContain('Dana Loader');
    expect(html).toContain('7 Loading Dock Rd · Day 1 of 2');
    expect(html).toContain('From the estimator');
    expect(html).toContain('Gate code 4411.');
    expect(html).toContain('From the office');
    expect(html).toContain('Park on the street.');
    expect(html).not.toMatch(/\$/);
  });

  it('says when nothing starts today, and keeps the tabs (44 px or more)', () => {
    const html = render([localJob({ scheduledStart: '2026-11-21' })]);
    expect(html).toContain('no job starts today');
    expect(html).toContain('Nothing to load for today.');
    expect(html).toMatch(/role="tab"[^>]*min-h-\[52px\]/);
  });
});

/** One day's list as the card shows it, with the ticks this phone has stored for the day. */
const renderDay = (jobs: LocalJob[], ticks: Ticks) =>
  renderToStaticMarkup(
    createElement(DayBody, {
      day: dayLoadList(
        jobs.map((j) => j.job),
        TODAY,
      ),
      equipment: alwaysBringLines(['Ladders']),
      ticks,
      onToggle: () => {},
      onOpen: () => {},
      when: 'today',
    }),
  );
const boxOf = (html: string, name: string) => new RegExp(`<button[^>]*role="checkbox"[^>]*>(?:(?!</button>).)*${name}`).exec(html)?.[0] ?? '';
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('crew Load list: a tick holds the amount it was loaded at (review LOAD-TICK-1)', () => {
  const KEY = 'm:cellulose|bag|blown cellulose';

  it('a material ticked at 20 bags is not ticked when the day now needs 63, and says what changed', () => {
    const html = renderDay([localJob({})], { [KEY]: { qty: 20, plusUnknown: false } });
    const box = boxOf(html, 'Blown cellulose');
    expect(box).toContain('aria-checked="false"');
    expect(words(html)).toContain('Changed after it was ticked: was 20 bags, now 63 bags.');
  });

  it('ticked at 63 bags it is loaded, with no change note; a thing to bring stays ticked as it was', () => {
    const html = renderDay([localJob({})], { [KEY]: { qty: 63, plusUnknown: false }, 'a:ladders': true });
    expect(boxOf(html, 'Blown cellulose')).toContain('aria-checked="true"');
    expect(boxOf(html, 'Ladders')).toContain('aria-checked="true"');
    expect(html).not.toContain('Changed after it was ticked');
  });
});

describe('crew Load list: a material set to 0 on the estimate is not loaded (review LOAD-ZERO-1)', () => {
  const withScope = (extra: ScopeLine[][]) =>
    localJob({
      areas: localJob({}).job.areas.map((a, i) => ({ ...a, scope: [...a.scope, ...(extra[i] ?? [])] })),
    });

  it('leaves the material out: no row, no box, not counted', () => {
    const zero: ScopeLine = { product: 'air_sealing', kind: 'material', description: 'Air sealing foam', qty: 0, unit: 'sqft', hours: null };
    const html = render([withScope([[zero], [zero]])]);
    expect(html).not.toContain('Air sealing foam');
    expect(html).not.toContain('Amount not on the estimate');
    expect(html).toContain('0 of 1 loaded');
  });

  it('keeps the part of a material with no amount on the estimate next to the part with one', () => {
    const unknown: ScopeLine = { product: 'cellulose', kind: 'material', description: 'Blown cellulose', qty: null, unit: 'bag', hours: null };
    const html = words(renderDay([withScope([[], [unknown]])], {}));
    expect(html).toContain('63 bags');
    expect(html).toContain('Plus an amount not on the estimate');
  });
});

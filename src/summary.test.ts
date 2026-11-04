import { describe, expect, it } from 'vitest';
import { newJob, newSpace } from './model';
import { exportJson, foamDeskLink, summaryText } from './summary';

function job() {
  const j = newJob();
  j.customer = 'Pat Smith';
  const attic = { ...newSpace('attic_floor', []), shape: { kind: 'rect' as const, dims: { A: '40', B: '30' } } };
  const crawl = newSpace('crawl_floor', []);
  j.spaces = [attic, crawl];
  return j;
}

describe('summary', () => {
  it('builds the Foam Desk link', () => {
    expect(foamDeskLink('attic_floor', 1199.6)).toBe('https://koala-foam-desk.vercel.app/?sqft=1200&type=attic_floor');
  });

  it('writes a readable summary, flagging incomplete spaces', () => {
    const text = summaryText(job(), new Date('2026-11-04T12:00:00'));
    expect(text).toContain('Customer: Pat Smith');
    expect(text).toContain('Attic Floor: 1,200 sq ft net');
    expect(text).toContain('Crawl Floor: incomplete');
    expect(text).toContain('All spaces: 1,200 sq ft');
  });

  it('exports inputs and results as JSON', () => {
    const j = job();
    const data = JSON.parse(exportJson(j, { [j.spaces[0]!.id]: 3 }));
    expect(data.spaces[0]).toMatchObject({ netSqft: 1200, photos: 3, complete: true });
    expect(data.spaces[0].input.shape.dims).toEqual({ A: '40', B: '30' });
    expect(data.totals).toEqual([
      { type: 'attic_floor', name: 'Attic Floor', netSqft: 1200, spaces: 1 },
      { type: 'crawl_floor', name: 'Crawl Floor', netSqft: 0, spaces: 1 },
    ]);
  });
});

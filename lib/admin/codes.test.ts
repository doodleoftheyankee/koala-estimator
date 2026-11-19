import { describe, expect, it } from 'vitest';
import { codeEditionsSentence, pricedCodeRequirement } from './codes';

// The code minimums the migrations seed (market defaults: 2018 IECC where the town enforces it).
const SEEDED = [
  { job_type: 'attic', assembly: 'ceiling', min_r: 49, code_edition: '2018 IECC (local)', is_default: true },
  { job_type: 'walls', assembly: 'wood_frame_wall', min_r: 20, code_edition: '2018 IECC (local)', is_default: true },
  { job_type: 'crawlspace', assembly: 'crawl_wall', min_r: 10, code_edition: '2018 IECC (local)', is_default: true },
  { job_type: 'crawlspace', assembly: 'floor', min_r: 19, code_edition: '2018 IECC (local)', is_default: true },
  { job_type: 'rim_joist', assembly: 'basement_wall', min_r: 10, code_edition: '2018 IECC (local)', is_default: true },
  { job_type: 'garage', assembly: 'ceiling', min_r: 30, code_edition: 'company default', is_default: true },
  { job_type: 'commercial', assembly: 'ceiling', min_r: 30, code_edition: 'company default', is_default: true },
];

describe('code minimums from the data (L38, RF-17, S2-F18)', () => {
  it('the banner names the editions in the data, no town or code year typed in the code', () => {
    expect(codeEditionsSentence(SEEDED)).toBe('2018 IECC (local) and company default');
    expect(codeEditionsSentence(SEEDED.map((c) => ({ ...c, code_edition: c.code_edition.replace('2018', '2024') })))).toBe('2024 IECC (local) and company default');
    expect(codeEditionsSentence([{ ...SEEDED[0]!, code_edition: '  ' }])).toBeNull();
    expect(codeEditionsSentence([])).toBeNull();
  });

  it('the crawlspace placeholder shows the floor the engine prices (R-19), not the crawl wall (R-10)', () => {
    // The page used to take the first default row of the job type: the crawlspace wall, R-10.
    expect(SEEDED.find((c) => c.job_type === 'crawlspace' && c.is_default)!.min_r).toBe(10);
    expect(pricedCodeRequirement(SEEDED, 'crawlspace')?.min_r).toBe(19);
    expect(pricedCodeRequirement(SEEDED, 'attic')?.min_r).toBe(49);
    expect(pricedCodeRequirement(SEEDED, 'rim_joist')?.min_r).toBe(10);
    // A job type with only another assembly falls back to it, as the engine does.
    expect(pricedCodeRequirement([{ ...SEEDED[2]! }], 'crawlspace')?.min_r).toBe(10);
    expect(pricedCodeRequirement(SEEDED, 'nothing')).toBeUndefined();
  });
});

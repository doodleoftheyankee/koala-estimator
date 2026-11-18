import { describe, expect, it } from 'vitest';
import { recommendedTier } from './recommended';

const opts = [{ tier: 'good' }, { tier: 'better' }, { tier: 'best' }] as const;

describe('recommendedTier', () => {
  it('is the option the estimator picked', () => {
    expect(recommendedTier(opts, 'best')).toEqual({ tier: 'best', picked: true });
  });

  it('falls back to Better, then the first option, and says it is the default', () => {
    expect(recommendedTier(opts, null)).toEqual({ tier: 'better', picked: false });
    expect(recommendedTier([{ tier: 'good' }, { tier: 'best' }], null)).toEqual({ tier: 'good', picked: false });
    expect(recommendedTier(opts, 'gone')).toEqual({ tier: 'better', picked: false });
  });

  it('is nothing when there are no options', () => {
    expect(recommendedTier([], 'better')).toBeNull();
  });
});

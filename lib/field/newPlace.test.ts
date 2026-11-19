import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDraft } from '@/lib/sync/draft';
import { bundleForNewEstimate, BUNDLE_WAIT_MS, newEstimatePlace, withPlaceIfBlank } from './newPlace';

const bundle = (newEstimate?: { city: string; state: string }) => ({ hash: 'h', business: newEstimate ? { gaps: [], newEstimate } : undefined }) as never;

describe('the town and state a new estimate starts in (review B flow-B13, OD14)', () => {
  it('is the pair the bundle names, or nothing: never a town without its state', () => {
    expect(newEstimatePlace(bundle({ city: 'Springfield', state: 'IL' }))).toEqual({ city: 'Springfield', state: 'IL' });
    expect(newEstimatePlace(bundle({ city: 'Springfield', state: '' }))).toBeNull();
    expect(newEstimatePlace(bundle({ city: '', state: 'IL' }))).toBeNull();
    expect(newEstimatePlace(bundle())).toBeNull();
    expect(newEstimatePlace(null)).toBeNull();
  });

  it('fills both, only while both are still blank', () => {
    const d = newDraft(new Date('2026-11-19T12:00:00Z'));
    const filled = withPlaceIfBlank(d, { city: 'Springfield', state: 'IL' });
    expect([filled.property.city, filled.property.state]).toEqual(['Springfield', 'IL']);
    const typed = { ...d, property: { ...d.property, city: 'Dover' } };
    expect(withPlaceIfBlank(typed, { city: 'Springfield', state: 'IL' })).toBe(typed);
  });
});

describe('bundleForNewEstimate: a phone with no bundle yet waits for it, at most 3 s, when online', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the cached bundle at once; offline it does not wait', async () => {
    const fetchBundle = vi.fn(async () => bundle({ city: 'X', state: 'YZ' }));
    const cached = bundle({ city: 'Springfield', state: 'IL' });
    expect(await bundleForNewEstimate(cached, fetchBundle, true)).toBe(cached);
    expect(await bundleForNewEstimate(null, fetchBundle, false)).toBeNull();
    expect(fetchBundle).not.toHaveBeenCalled();
  });

  it('first open, online: the bundle that arrives within 3 s; after 3 s it goes on without one', async () => {
    vi.useFakeTimers();
    const arrives = (ms: number) => () => new Promise((r) => setTimeout(() => r(bundle({ city: 'Springfield', state: 'IL' })), ms)) as never;
    const quick = bundleForNewEstimate(null, arrives(1200), true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(newEstimatePlace(await quick)).toEqual({ city: 'Springfield', state: 'IL' });
    expect(BUNDLE_WAIT_MS).toBe(3000);
    const slow = bundleForNewEstimate(null, arrives(10_000), true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await slow).toBeNull();
    // A failed download is no bundle either.
    expect(await bundleForNewEstimate(null, () => Promise.reject(new Error('Signed out')), true)).toBeNull();
  });
});

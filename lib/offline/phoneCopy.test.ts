import { describe, expect, it } from 'vitest';
import { hasSavedCopy } from './phoneCopy';

const store = (hit: string | null) => ({
  match: async (req: RequestInfo | URL, opts?: CacheQueryOptions) => {
    expect(opts?.ignoreVary).toBe(true);
    return String(req) === hit ? new Response('<html>') : undefined;
  },
});

describe('hasSavedCopy (review B flow-B8)', () => {
  it('is true only when this browser holds the page the link opens', async () => {
    expect(await hasSavedCopy('/field', store('/field'))).toBe(true);
    expect(await hasSavedCopy('/field', store('/crew'))).toBe(false);
    expect(await hasSavedCopy('/field', store(null))).toBe(false);
  });

  it('is false with no cache storage (an insecure page, an old browser) or when it fails', async () => {
    expect(await hasSavedCopy('/field', undefined)).toBe(false);
    expect(await hasSavedCopy('/field', { match: async () => Promise.reject(new Error('SecurityError')) })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import * as phoneCopy from './phoneCopy';
import { hasSavedCopy, phoneAppFor } from './phoneCopy';

const store = (hit: string | null) => ({
  match: async (req: RequestInfo | URL, opts?: CacheQueryOptions) => {
    expect(opts?.ignoreVary).toBe(true);
    // The shell is saved under its bare path; a query only says which job (sw.js shellFor).
    const path = opts?.ignoreSearch ? String(req).split('?')[0] : String(req);
    return path === hit ? new Response('<html>') : undefined;
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

// Release, "blower door under the accuracy rules": /unreachable opened for the blower door tool
// offers the tool's own saved copy, for the same job or estimate. Before, it offered the
// estimator's field app ("Open the estimates on this phone", /field), which a crew phone never has:
// a crew lead was told "This phone has no saved copy of the app yet" while the tool was saved.
describe('phoneAppFor (L36, review B flow-B8)', () => {
  const JOB = '/field/blower-door?job=0b000000-0000-4000-8000-000000000001';

  it('offers the blower door tool for the tool, with its job or estimate', () => {
    expect(phoneAppFor(JOB)).toEqual({ href: JOB, copy: '/field/blower-door', label: 'Open the blower door tool on this phone' });
    expect(phoneAppFor('/field/blower-door')).toEqual({ href: '/field/blower-door', copy: '/field/blower-door', label: 'Open the blower door tool on this phone' });
  });

  it('keeps the field and crew apps as they were, and offers nothing for the Roof lookup or office pages', () => {
    expect(phoneAppFor('/field')).toEqual({ href: '/field', copy: '/field', label: 'Open the estimates on this phone' });
    expect(phoneAppFor('/field?e=1')).toEqual({ href: '/field', copy: '/field', label: 'Open the estimates on this phone' });
    expect(phoneAppFor('/crew?j=1')).toEqual({ href: '/crew', copy: '/crew', label: 'Open the crew app on this phone' });
    expect(phoneAppFor('/field/roof')).toBeNull();
    expect(phoneAppFor('/field/blower-doorx')).toEqual({ href: '/field', copy: '/field', label: 'Open the estimates on this phone' });
    expect(phoneAppFor('/estimates')).toBeNull();
  });

  it('finds the tool saved under its bare path for any job', async () => {
    expect(await hasSavedCopy('/field/blower-door', store('/field/blower-door'))).toBe(true);
    expect(await hasSavedCopy(JOB, store('/field/blower-door'))).toBe(true);
    expect(await hasSavedCopy('/field', store('/field/blower-door'))).toBe(false);
  });
});

// Release review C FLOW-4: /unreachable for a page that is not one of the phone's apps (All my
// estimates, Jobs, Pricing) offered only "Try again", which loops while Koala is down; in the
// home-screen app there is no browser back button. It now also offers the phone's saved apps.
describe('fallbackAppsFor (release review C FLOW-4)', () => {
  const FIELD = { href: '/field', copy: '/field', label: 'Open the estimates on this phone' };
  const CREW = { href: '/crew', copy: '/crew', label: 'Open the crew app on this phone' };
  it("offers the field and crew apps for a page that is not one of the phone's apps", () => {
    const fallbackAppsFor = (phoneCopy as Record<string, unknown>).fallbackAppsFor as ((next: string) => unknown) | undefined;
    expect(fallbackAppsFor, 'fallbackAppsFor').toBeTypeOf('function');
    for (const next of ['/estimates', '/jobs', '/admin/pricing', '/field/roof', '/']) expect(fallbackAppsFor!(next), next).toEqual([FIELD, CREW]);
  });
  it('offers nothing more for one of the apps: the app itself is offered (phoneAppFor)', () => {
    const fallbackAppsFor = (phoneCopy as Record<string, unknown>).fallbackAppsFor as ((next: string) => unknown) | undefined;
    for (const next of ['/field', '/field?e=1', '/crew?j=1', '/field/blower-door?job=1']) expect(fallbackAppsFor?.(next), next).toEqual([]);
  });
});

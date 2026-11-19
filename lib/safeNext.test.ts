import { describe, expect, it } from 'vitest';
import { safeNext } from './safeNext';

describe('safeNext', () => {
  it('keeps a path on this site, with its query', () => {
    expect(safeNext('/field')).toBe('/field');
    expect(safeNext('/field/roof?address=12%20Elkton%20Rd%2C%20Newark')).toBe('/field/roof?address=12%20Elkton%20Rd%2C%20Newark');
    expect(safeNext('/jobs#today')).toBe('/jobs#today');
  });

  it('sends anything that leaves the site to the fallback', () => {
    for (const bad of ['//evil.com', '/\\evil.com', '/\\\\evil.com', '/\t/evil.com', '/\n/evil.com', 'https://evil.com', 'evil.com', 'javascript:alert(1)', '', null, undefined]) {
      expect(safeNext(bad), String(bad)).toBe('/');
    }
    expect(safeNext('//evil.com', '/crew')).toBe('/crew');
  });

  // Review B database-B1: the check ran on the raw input, but the path it returned was normalised
  // by URL, and dot segments ("/./", "/x/../", "%2e") turn "/.//evil.com" into "//evil.com".
  it('a path that becomes "//host" or "/\\host" once dot segments are resolved goes to the fallback (database-B1)', () => {
    for (const bad of ['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '/%2e%2e//evil.com', '/./\\evil.com', '/x/../\\evil.com', '/.//evil.example/x']) {
      expect(safeNext(bad), bad).toBe('/');
    }
    // Ordinary dot segments still land on the page they name.
    expect(safeNext('/field/./roof')).toBe('/field/roof');
    expect(safeNext('/field/x/../roof?a=1')).toBe('/field/roof?a=1');
  });

  it('anything that is not one string goes to the fallback: a repeated ?next= is an array (database-B1, the /login 500)', () => {
    for (const bad of [['/a', '/b'], ['/a'], 42, {}, true]) {
      expect(safeNext(bad as unknown), JSON.stringify(bad)).toBe('/');
    }
  });
});

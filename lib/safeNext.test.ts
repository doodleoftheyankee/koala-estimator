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
});

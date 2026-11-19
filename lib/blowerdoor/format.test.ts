// Release, "blower door under the accuracy rules": one formatter. The blower door code formats
// money, numbers and dates only through lib/format.ts (formatMoney, num, fixed, formatDate), where
// the locale and the business time zone live, the same as every other screen of the accuracy round.
// Before: its own Intl.DateTimeFormat for the effective date, 'en-US' toLocaleString for field
// limits and ACH50, and "$" glued to raw numbers in the Rebate programs messages ("$1300").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixed, formatDate, calendarDay } from '@/lib/format';
import { formatEffectiveDate } from './settings';
import { readField, RULES } from './numbers';
import { achText } from './words';

const ROOT = join(import.meta.dirname, '..', '..');
const PLACES = ['lib/blowerdoor', 'lib/offline/blowerDoor.ts', 'lib/offline/blowerDoorCore.ts', 'app/field/blower-door', 'app/admin/rebates', 'app/api/blower-door', 'app/jobs/[id]/BlowerDoorCard.tsx'];

function files(path: string): string[] {
  const full = join(ROOT, path);
  let st;
  try {
    st = statSync(full);
  } catch {
    return [];
  }
  if (st.isFile()) return [full];
  return readdirSync(full).flatMap((f) => files(join(path, f)));
}

describe('the blower door code formats through lib/format.ts', () => {
  const code = PLACES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__fixtures__'));

  it('is there to check', () => {
    expect(code.length).toBeGreaterThan(10);
  });

  it.each([
    ['its own Intl formatter', /\bIntl\./],
    ['a locale of its own', /['"]en-US['"]/],
    ['toLocaleString', /\.toLocaleString\(/],
    ['a dollar sign glued to a raw number', /\$\$\{/],
  ])('has no %s', (_what, re) => {
    const hits = code.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it('reads the same as before where it was right: effective dates, field limits, ACH50', () => {
    expect(formatEffectiveDate('2024-11-01')).toBe('Nov 1, 2024');
    expect(formatEffectiveDate('2024-11-01')).toBe(formatDate(calendarDay('2024-11-01')));
    expect(formatEffectiveDate('2024-13-01')).toBeNull();
    expect(readField('0', RULES.cost)).toEqual({ state: 'invalid', error: 'Air sealing price must be more than $0 and at most $1,000,000.' });
    expect(readField('60000', RULES.cfm)).toEqual({ state: 'invalid', error: 'Fan flow must be more than 0 CFM and at most 50,000 CFM.' });
    expect(readField('0.5', RULES.nFactor)).toEqual({ state: 'invalid', error: 'Zone N-factor must be at least 1 and at most 40.' });
    expect(achText(7.1)).toBe('7.10');
    expect(achText(20.857)).toBe('20.86');
    expect(achText(1234.5)).toBe('1,234.50');
    expect(fixed(7.1, 2)).toBe('7.10');
  });
});

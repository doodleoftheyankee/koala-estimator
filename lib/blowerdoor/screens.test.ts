// The blower door screens use the Daymark colour tokens only (components/daymark, app/globals.css),
// so they follow Day, Night and Sun+: no raw Tailwind palette colours (text-slate-900 and the like).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCREENS = [
  ...readdirSync(join(ROOT, 'app', 'field', 'blower-door')).map((f) => join('app', 'field', 'blower-door', f)),
  ...readdirSync(join(ROOT, 'app', 'admin', 'rebates')).map((f) => join('app', 'admin', 'rebates', f)),
  join('app', 'jobs', '[id]', 'BlowerDoorCard.tsx'),
].filter((f) => f.endsWith('.tsx'));
const PALETTE = /\b(?:text|bg|border|ring|fill|stroke|outline|divide|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d{2,3})?\b/g;

describe('the blower door screens', () => {
  it('use Daymark colour tokens only (BD-R9)', () => {
    expect(SCREENS.length).toBeGreaterThan(4);
    for (const f of SCREENS) expect(readFileSync(join(ROOT, f), 'utf8').match(PALETTE), relative(ROOT, join(ROOT, f))).toBeNull();
  });
});

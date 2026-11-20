// Rebate programs are franchise settings, not code: no program, sponsor, state or dollar amount
// may appear in the blower door tool's code. Each franchise enters its own programs on the Rebate
// programs page; this franchise's are seeded by the migration (SQL), and tests may use them as data.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('the blower door code', () => {
  const code = PLACES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__fixtures__'));

  it('is there to check', () => {
    expect(code.length).toBeGreaterThan(5);
  });

  it.each(['Delaware', 'Energize', 'ENERGY STAR', 'Assisted Home'])('never names %s', (word) => {
    for (const f of code) expect(readFileSync(f, 'utf8').includes(word), relative(ROOT, f)).toBe(false);
  });

  // Release, "blower door under the accuracy rules" (OD12, OD13): the tool, its copied summary, the
  // office card and the Rebate programs page name no company and no franchise, show no PLACEHOLDER
  // text and never send anyone to the business profile. Nothing needed changing: this keeps it so.
  it.each(['Koala Insulation', 'PLACEHOLDER', 'Placeholder', 'Business profile', 'business profile', '/admin/business', 'warranty', 'Newark', '(302)'])('never says %s', (word) => {
    for (const f of code) expect(readFileSync(f, 'utf8').includes(word), relative(ROOT, f)).toBe(false);
  });

  it('never types a dollar amount', () => {
    for (const f of code) {
      const text = readFileSync(f, 'utf8');
      expect(text.match(/\$\d[\d,]*/g), relative(ROOT, f)).toBeNull();
    }
  });
});

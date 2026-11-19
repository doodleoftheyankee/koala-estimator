// Hard rule 3: no franchise text in code. Every string literal, template text and JSX text in app/,
// lib/ and components/ (tests, lib/demo and fixtures aside: demo data and test data name a sample
// franchise on purpose) is read with the TypeScript parser, so comments do not count, and none may
// name one franchise: "Koala Insulation of …", Newark, Delaware or a (302) number (review B flow-B7,
// owner decision OD12). What a franchise prints comes from its settings; the brand is "Koala
// Insulation".
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FRANCHISE = /Koala Insulation of|Newark|Delaware|\(302\)/;

/**
 * The documented exceptions (docs/accuracy/ledger.txt, "Review B fixes and owner decisions
 * OD12-OD16", hard rule 3), by file and the exact literal:
 *  - lib/quotes/consent.ts LEGACY_ESIGN_CONSENT: the sentence quotes sent before the accuracy round
 *    were signed under; hard rule 1 keeps it word for word, and new quotes never use it.
 *  - lib/quotes/consent.ts STATE_NAMES: every US state's name, Delaware among them.
 */
const EXCEPTIONS: ReadonlyArray<{ file: string; literal: string }> = [
  {
    file: 'lib/quotes/consent.ts',
    literal:
      'I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and Delaware UETA). I accept the option and price I selected above and the terms of this quote.',
  },
  { file: 'lib/quotes/consent.ts', literal: 'Delaware' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__fixtures__' || rel === path.join('lib', 'demo')) continue;
      out.push(...sourceFiles(rel));
    } else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every piece of text the code holds: string and template literals, and JSX text. */
function literals(file: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) found.push(n.text);
    else if (ts.isJsxText(n)) found.push(n.getText(src));
    n.forEachChild(visit);
  };
  visit(src);
  return found;
}

describe('hard rule 3: no franchise text in code', () => {
  const files = ['app', 'lib', 'components'].flatMap(sourceFiles);

  it('reads the code it means to (a sanity check of the scan itself)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(path.join('lib', 'quotes', 'settings.ts'));
    expect(files.some((f) => f.startsWith(path.join('lib', 'demo')))).toBe(false);
    // It would catch one: the old default company is a literal like any other.
    expect(FRANCHISE.test("export const DEFAULT_COMPANY = 'Koala Insulation of Newark';")).toBe(true);
    expect(literals(path.join('lib', 'quotes', 'consent.ts')).some((l) => FRANCHISE.test(l))).toBe(true);
  });

  it('no string literal in app/, lib/ or components/ names a franchise, beyond the documented exceptions', () => {
    const hits = files.flatMap((f) =>
      literals(f)
        .filter((l) => FRANCHISE.test(l))
        .filter((l) => !EXCEPTIONS.some((x) => x.file === f.split(path.sep).join('/') && x.literal === l))
        .map((l) => `${f}: ${JSON.stringify(l.length > 120 ? `${l.slice(0, 120)}…` : l)}`),
    );
    expect(hits).toEqual([]);
  });
});

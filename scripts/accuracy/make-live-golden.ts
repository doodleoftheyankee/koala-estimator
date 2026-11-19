// Turns the read-only production export into the live golden set, checked against the database's
// own checksums. Production is only ever read (scripts/accuracy/golden-export.sql and
// scripts/accuracy/bundle-rows.sql, SELECT statements). The result stays OUT of git.
//
// Usage: node scripts/accuracy/run.mjs scripts/accuracy/make-live-golden.ts <estimates export> <rows export> <out dir>
//   <estimates export>: the result of golden-export.sql: one row {doc, md5, chars, estimates, quotes,
//     options, areas}, as the SQL tool saved it (its JSON wrapper is read through) or as plain JSON.
//   <rows export>: the result of bundle-rows.sql as `select rows::text as rows_text, md5(rows::text) as md5`.
// Writes <out>/live-estimates.json (the export, byte for byte), <out>/live-rows.json and
// <out>/live-manifest.json (checksums, counts, and how the live rows differ from the seeded fixture).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { diffRows } from '@/lib/accuracy/rows';
import { bundleFromRows, seededRows } from '@/lib/pricing/__fixtures__/seeded';
import type { SnapshotRows } from '@/lib/server/snapshot';
import type { LiveExport } from './golden';

const [estimatesPath, rowsPath, outDir] = process.argv.slice(2);
if (!estimatesPath || !rowsPath || !outDir) throw new Error('Usage: make-live-golden.ts <estimates export> <rows export> <out dir>');

/** The result rows of one SQL tool call, through whichever wrapper the tool saved it in. */
function resultRows(file: string): Array<Record<string, unknown>> {
  let v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let i = 0; i < 4; i++) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'type' in v[0] && 'text' in v[0]) {
      v = JSON.parse((v[0] as { text: string }).text);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && 'result' in v && typeof (v as { result: unknown }).result === 'string') {
      const text = (v as { result: string }).result;
      // The rows sit between the tool's data markers (the opening one on a line of its own).
      const m = /<untrusted-data-([\w-]+)>\n([\s\S]*?)\n<\/untrusted-data-\1>/.exec(text);
      v = JSON.parse(m ? m[2]! : text);
      continue;
    }
    break;
  }
  if (!Array.isArray(v)) throw new Error(`${file}: no result rows found`);
  return v as Array<Record<string, unknown>>;
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const fail = (msg: string): never => {
  throw new Error(`The export does not match production: ${msg}`);
};

// Estimates.
const [est] = resultRows(estimatesPath);
if (!est || typeof est.doc !== 'string') fail('no doc column in the estimates export');
const doc = est!.doc as string;
if (md5(doc) !== est!.md5) fail(`md5 ${md5(doc)} on disk, ${String(est!.md5)} in the database`);
if ([...doc].length !== Number(est!.chars)) fail(`${[...doc].length} characters on disk, ${String(est!.chars)} in the database`);
const live = JSON.parse(doc) as LiveExport;
const counts = {
  estimates: live.estimates.length,
  quotes: live.estimates.reduce((a, e) => a + e.quotes.length, 0),
  options: live.estimates.reduce((a, e) => a + e.options.length, 0),
};
for (const k of ['estimates', 'quotes', 'options'] as const) {
  if (counts[k] !== Number(est![k])) fail(`${counts[k]} ${k} in the export, ${String(est![k])} in the database`);
}

// Pricing rows.
const [rowsRow] = resultRows(rowsPath);
if (!rowsRow || typeof rowsRow.rows_text !== 'string') fail('no rows_text column in the rows export');
const rowsText = rowsRow!.rows_text as string;
if (md5(rowsText) !== rowsRow!.md5) fail(`pricing rows md5 ${md5(rowsText)} on disk, ${String(rowsRow!.md5)} in the database`);
const rows = JSON.parse(rowsText) as SnapshotRows;
const liveBundle = bundleFromRows(rows);
const differences = diffRows(rows, seededRows);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'live-estimates.json'), doc);
fs.writeFileSync(path.join(outDir, 'live-rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
const manifest = {
  madeAt: new Date().toISOString(),
  estimates: { md5: md5(doc), chars: [...doc].length, ...counts, areasInDatabase: Number(est!.areas) },
  rows: { md5: md5(rowsText), bundleHash: liveBundle.hash, seededBundleHash: bundleFromRows(seededRows).hash, winModel: rows.winModel ? rows.winModel.id : null },
  liveRowsVsSeeded: differences.length ? differences : 'the same, row for row (ids and the win model aside)',
};
fs.writeFileSync(path.join(outDir, 'live-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  [
    `Checked against production: ${counts.estimates} estimates, ${counts.quotes} quotes, ${counts.options} options; md5 ${manifest.estimates.md5}.`,
    `Pricing rows md5 ${manifest.rows.md5}; live bundle ${liveBundle.hash}; seeded bundle ${manifest.rows.seededBundleHash}.`,
    `Live rows against the seeded fixture: ${differences.length ? `\n  ${differences.join('\n  ')}` : 'the same, row for row (ids and the win model aside).'}`,
    `Wrote ${outDir}/live-estimates.json, live-rows.json and live-manifest.json.`,
  ].join('\n'),
);

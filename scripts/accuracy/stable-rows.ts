// Turns the pricing rows read by bundle-rows.sql into the committed fixture: stable ids, pricing
// settings only, sorted (lib/accuracy/rows.ts stableRows).
// Usage: node scripts/accuracy/run.mjs scripts/accuracy/stable-rows.ts <rows.json> <out.json>
import fs from 'node:fs';
import { stableRows } from '@/lib/accuracy/rows';
import type { SnapshotRows } from '@/lib/server/snapshot';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: stable-rows.ts <rows.json> <out.json>');
const rows = JSON.parse(fs.readFileSync(input, 'utf8')) as SnapshotRows;
fs.writeFileSync(output, `${JSON.stringify(stableRows(rows), null, 2)}\n`);
console.log(`${output}: ${rows.materials.length} materials, ${rows.coefficients.length} coefficients, ${rows.tierTemplates.length} tier templates`);

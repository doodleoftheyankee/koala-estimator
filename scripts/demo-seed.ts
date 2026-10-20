// Writes the demo history (lib/demo/seed.ts) as SQL files, for loading into a local database.
// Usage: npx tsx scripts/demo-seed.ts <config.json> <out-dir>
//   config.json: the pricing rows (SnapshotRows) of the target database.
import fs from 'node:fs';
import path from 'node:path';
import { buildDemoSeed } from '@/lib/demo/seed';
import { makeBundle, type SnapshotRows } from '@/lib/server/snapshot';

const [configPath, outDir] = process.argv.slice(2);
if (!configPath || !outDir) throw new Error('Usage: tsx scripts/demo-seed.ts <config.json> <out-dir>');
const rows = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SnapshotRows;
const { batches, summary } = buildDemoSeed({ bundle: makeBundle(rows), settings: rows.settings, now: new Date() });
fs.mkdirSync(outDir, { recursive: true });
batches.forEach((b, i) => fs.writeFileSync(path.join(outDir, `demo-${String(i + 1).padStart(2, '0')}.sql`), `begin;\n${b}\ncommit;\n`));
console.log(`${summary} in ${batches.length} batches -> ${outDir}`);

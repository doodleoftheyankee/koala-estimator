// Runs scripts/accuracy/render-stored.ts (or another script that renders server code outside
// Next.js) like run.mjs, with 'server-only' and the service-role client replaced by stand-ins
// (scripts/accuracy/stubs), so the real customer quote page can be rendered from a stored quote.
// Usage: node scripts/accuracy/render-run.mjs scripts/accuracy/render-stored.ts [args...]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const here = path.dirname(fileURLToPath(import.meta.url));
const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node scripts/accuracy/render-run.mjs <script.ts> [args...]');
  process.exit(2);
}
process.argv = [process.argv[0], path.resolve(script), ...args];
await runnerImport(path.resolve(script), {
  configFile: false,
  root,
  logLevel: 'error',
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: path.join(here, 'stubs/server-only.ts') },
      { find: /^@\/lib\/supabase\/admin$/, replacement: path.join(here, 'stubs/admin.ts') },
      { find: /^@\//, replacement: `${root}/` },
    ],
  },
});

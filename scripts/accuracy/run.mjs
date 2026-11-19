// Runs one of the TypeScript accuracy scripts with the app's '@/' imports, through Vite's module
// runner (the engine vitest already uses), so the scripts need no extra tool.
// Usage: node scripts/accuracy/run.mjs scripts/accuracy/violations.ts [args...]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node scripts/accuracy/run.mjs <script.ts> [args...]');
  process.exit(2);
}
// The script reads its own arguments from process.argv.slice(2).
process.argv = [process.argv[0], path.resolve(script), ...args];
await runnerImport(path.resolve(script), {
  configFile: false,
  root,
  logLevel: 'error',
  resolve: { alias: { '@': root } },
});

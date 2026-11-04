import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emits /sw.js listing every file in the build (plus the public folder's manifest and icons),
 * versioned by a hash of that list, so each deploy installs a fresh offline cache.
 */
function serviceWorker(): Plugin {
  return {
    name: 'atticscan-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const publicFiles = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/icon.svg'];
      const precache = [...new Set(['/', '/index.html', ...[...files, ...publicFiles].map((f) => `/${f}`)])];
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      const template = readFileSync(new URL('./src/sw-template.js', import.meta.url), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template
          .replace('const VERSION = __VERSION__;', `const VERSION = ${JSON.stringify(version)};`)
          .replace('const PRECACHE = __PRECACHE__;', `const PRECACHE = ${JSON.stringify(precache)};`),
      });
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  build: { target: 'es2020', sourcemap: false },
});

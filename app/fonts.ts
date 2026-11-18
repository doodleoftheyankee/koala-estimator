// Daymark fonts, self-hosted from Fontsource (npm) and bundled by Next into /_next/static/media,
// so the service worker (public/sw.js) caches them cache-first and the offline app keeps its look.
// Only the latin subset, upright style, is loaded.
//
//  - Archivo: the "wdth" file of @fontsource-variable/archivo carries BOTH axes (width 62–125 %,
//    weight 100–900). Gauge numerals use it at 72 % width / 800; sign labels at 118 % / 700.
//  - Atkinson Hyperlegible Next: weight axis 200–800. All reading text, buttons and inputs.
//    Its zero is slashed and the font has no plain-zero alternate (no `zero` or stylistic-set
//    feature in the file), so the quiet register sets digits in Archivo instead: `plainDigits`
//    below is the same Archivo file limited to 0–9, listed first in the quiet text stack.
import localFont from 'next/font/local';

// next/font needs literal options, so the Archivo path is written out twice.
export const archivo = localFont({
  src: '../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2',
  variable: '--font-archivo',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  declarations: [{ prop: 'font-stretch', value: '62% 125%' }],
  fallback: ['Arial Narrow', 'Arial', 'sans-serif'],
  adjustFontFallback: false,
});

export const atkinson = localFont({
  src: '../node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2',
  variable: '--font-atkinson',
  weight: '200 800',
  style: 'normal',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

/** Archivo's plain-zero digits only (U+0030–0039). Quiet register: customer-facing numbers. */
export const plainDigits = localFont({
  src: '../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2',
  variable: '--font-plain-digits',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  declarations: [
    { prop: 'font-stretch', value: '62% 125%' },
    { prop: 'unicode-range', value: 'U+0030-0039' },
  ],
  fallback: [],
  adjustFontFallback: false,
});

/** Class names that define --font-archivo, --font-atkinson and --font-plain-digits. */
export const fontVariables = `${archivo.variable} ${atkinson.variable} ${plainDigits.variable}`;

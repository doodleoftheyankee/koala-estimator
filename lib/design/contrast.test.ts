// Reads the Daymark tokens straight from app/globals.css and checks every contrast pair the design
// promises, in Day, Night and Sun+, in both registers. A token change that drops a pair below its
// threshold fails here. Also checks that the "system" copies of Night and Sun+ (the media-query
// blocks) match the explicit themes, and that the quiet register keeps the hi-vis edge.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRAST_PAIRS, REGISTERS, THEMES, contrastRatio, pairApplies, parseHex, resolveToken, type RegisterName, type ThemeName } from './contrast';

const css = readFileSync(join(import.meta.dirname, '../../app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(re: RegExp, what: string): Record<string, string> {
  const m = re.exec(css);
  if (!m) throw new Error(`globals.css: cannot find the ${what} block`);
  const out: Record<string, string> = {};
  for (const decl of m[1]!.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim();
    if (name.startsWith('--')) out[name.slice(2)] = decl.slice(i + 1).trim();
  }
  return out;
}

const DAY = block(/:root,\s*\[data-theme='day'\],\s*\[data-theme='sun'\]\s*\{([^}]*)\}/, 'Day');
const NIGHT = block(/@media screen \{\s*\[data-theme='night'\]\s*\{([^}]*)\}/, 'Night');
const NIGHT_AUTO = block(/@media screen and \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/, 'Night (system)');
const SUN_OVER = block(/@media screen \{\s*\[data-theme='sun'\]\s*\{([^}]*)\}/, 'Sun+');
const SUN_AUTO = block(/@media screen and \(prefers-contrast: more\) \{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/, 'Sun+ (system)');
const GLOBAL = block(/:root\s*\{([^}]*--e-casing[^}]*)\}/, 'theme-independent');
const QUIET = block(/\n\[data-register='quiet'\]\s*\{([^}]*)\}/, 'quiet register');

const SUN = { ...DAY, ...SUN_OVER };
const THEME_TOKENS: Record<ThemeName, Record<string, string>> = { day: DAY, night: NIGHT, sun: SUN };

function tokens(theme: ThemeName, register: RegisterName): Record<string, string> {
  return { ...GLOBAL, ...THEME_TOKENS[theme], ...(register === 'quiet' ? QUIET : {}) };
}

describe('Daymark tokens in app/globals.css', () => {
  it('defines the same token names in Day and Night', () => {
    expect(Object.keys(NIGHT).sort()).toEqual(Object.keys(DAY).sort());
  });

  it('uses the same Night values for the "system" dark preference', () => {
    expect(NIGHT_AUTO).toEqual(NIGHT);
  });

  it('uses the same Sun+ values for the "system" more-contrast preference', () => {
    expect(SUN_AUTO).toEqual(SUN);
  });

  it('writes every colour token as #rrggbb', () => {
    for (const [theme, t] of Object.entries(THEME_TOKENS)) {
      for (const [name, value] of Object.entries(t)) {
        if (/^(bw|keel|lift|scrim|track-edge)/.test(name)) continue;
        expect(parseHex(value), `${theme} --${name}: ${value}`).not.toBeNull();
        expect(value, `${theme} --${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('keeps the Daymark source colours (DIRECTION.md)', () => {
    expect(DAY.ink).toBe('#0c0e10');
    expect(DAY.canvas).toBe('#edede7');
    expect(DAY.hivis).toBe('#d4f53c');
    expect(DAY['hivis-wash']).toBe('#f3fbd2');
    expect(NIGHT.hivis).toBe('#d4f53c');
    expect(NIGHT['on-hivis']).toBe('#0c0e10');
    expect(SUN.ink).toBe('#000000');
    expect(SUN.canvas).toBe('#ffffff');
  });

  it('never thins the hi-vis edge below 2px (3px in Sun+), in either register', () => {
    for (const theme of THEMES) {
      for (const register of REGISTERS) {
        const bw = Number.parseFloat(tokens(theme, register)['bw-go'] ?? '0');
        expect(bw, `${theme}/${register}`).toBeGreaterThanOrEqual(theme === 'sun' ? 3 : 2);
      }
    }
    for (const k of ['bw-go', 'hivis', 'on-hivis', 'hivis-edge']) expect(QUIET[k], `quiet must not override --${k}`).toBeUndefined();
  });

  it('gives the quiet register 1px rules, no keel, and the wash for chosen values', () => {
    expect(QUIET.bw).toBe('1px');
    for (const k of ['keel', 'keel-s', 'keel-go']) expect(QUIET[k]).toMatch(/^0 0 #0000$/); // a valid "no shadow" (not none)
    expect(QUIET['chosen-fill']).toBe('var(--hivis-wash)');
  });

  it('makes the main action hi-vis with its ink edge in the field, ink in the quiet register', () => {
    expect(GLOBAL['main-fill']).toBe('var(--hivis)');
    expect(GLOBAL['main-edge']).toBe('var(--hivis-edge)');
    expect(GLOBAL['on-main']).toBe('var(--on-hivis)');
    expect(QUIET['main-fill']).toBe('var(--ink)');
    expect(QUIET['main-keel']).toBe('0 0 #0000');
  });

  it('has room for big targets: 56px controls and 64px primary actions in the field', () => {
    expect(GLOBAL['ctl-h']).toBe('56px');
    expect(GLOBAL['ctl-h-go']).toBe('64px');
    expect(Number.parseFloat(QUIET['ctl-h'] ?? '0')).toBeGreaterThanOrEqual(48);
  });
});

describe('WCAG contrast of every promised pair', () => {
  for (const theme of THEMES) {
    for (const register of REGISTERS) {
      const t = tokens(theme, register);
      for (const pair of CONTRAST_PAIRS.filter((p) => pairApplies(p, theme, register))) {
        it(`${theme} · ${register} · ${pair.name} (${pair.fg} on ${pair.bg}) ≥ ${pair.min}`, () => {
          const fg = resolveToken(pair.fg, t);
          const bg = resolveToken(pair.bg, t);
          const a = fg ? parseHex(fg) : null;
          const b = bg ? parseHex(bg) : null;
          expect(a, `--${pair.fg} resolves to a colour (${fg})`).not.toBeNull();
          expect(b, `--${pair.bg} resolves to a colour (${bg})`).not.toBeNull();
          const ratio = contrastRatio(a!, b!);
          expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(pair.min);
        });
      }
    }
  }

  it('matches the ratios DIRECTION.md measured', () => {
    const r = (fg: string, bg: string) => Math.round(contrastRatio(parseHex(fg)!, parseHex(bg)!) * 100) / 100;
    expect(r(DAY.ink!, DAY.surface!)).toBe(19.34);
    expect(r(DAY['on-hivis']!, DAY.hivis!)).toBe(15.59);
    expect(r(DAY['ink-3']!, DAY.canvas!)).toBe(5.95);
    expect(r(NIGHT.ink!, NIGHT.surface!)).toBe(16.1);
    expect(r(NIGHT.edge!, NIGHT.surface!)).toBe(3.08);
    expect(r(SUN.ink!, SUN.hivis!)).toBe(16.93);
  });
});

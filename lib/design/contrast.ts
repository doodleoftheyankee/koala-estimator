// WCAG 2.x contrast for the Daymark tokens, and the pairs the design promises (DIRECTION.md).
// Used by lib/design/contrast.test.ts (reads app/globals.css) and by the /design page (reads the
// live CSS). Text needs 4.5:1; UI boundaries and icons need 3:1. Pure.

export type ThemeName = 'day' | 'night' | 'sun';
export type RegisterName = 'field' | 'quiet';

/** A token name without the leading "--" ("ink", "on-hivis"), or a literal "#rrggbb". */
export type ColorRef = string;

export interface ContrastPair {
  /** What it is, in plain words. */
  name: string;
  fg: ColorRef;
  bg: ColorRef;
  /** 4.5 for text, 3 for UI boundaries and icons. */
  min: number;
  /** Themes it applies to (default all three). */
  themes?: readonly ThemeName[];
  /** Registers it applies to (default both). */
  registers?: readonly RegisterName[];
}

/** Parses #rgb or #rrggbb; null for anything else (named colours, rgba, var()). */
export function parseHex(v: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Parses "rgb(12, 14, 16)" / "rgb(12 14 16)" as browsers report computed colours. */
export function parseRgb(v: string): [number, number, number] | null {
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function parseColor(v: string): [number, number, number] | null {
  return parseHex(v) ?? parseRgb(v);
}

/** Relative luminance (WCAG 2.x). */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The photo colours a map line must stand out from (lawn, grey shingles). */
export const MAP_GROUNDS = { lawn: '#5a7a3c', shingles: '#7d8288' } as const;

/**
 * Every pair Daymark promises. Covers DIRECTION.md's 54 measured pairs, plus the pairs the
 * legacy-palette remap and the components rely on (text on ink fills, the quiet register's
 * chosen wash, the focus ring, the toast accent).
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  // Reading text
  { name: 'Text on plates', fg: 'ink', bg: 'surface', min: 4.5 },
  { name: 'Text on the page', fg: 'ink', bg: 'canvas', min: 4.5 },
  { name: 'Text on wells', fg: 'ink', bg: 'sunken', min: 4.5 },
  { name: 'Secondary text on plates', fg: 'ink-2', bg: 'surface', min: 4.5 },
  { name: 'Secondary text on the page', fg: 'ink-2', bg: 'canvas', min: 4.5 },
  { name: 'Meta text on plates', fg: 'ink-3', bg: 'surface', min: 4.5 },
  { name: 'Meta text on the page', fg: 'ink-3', bg: 'canvas', min: 4.5 },
  { name: 'Meta text on wells', fg: 'ink-3', bg: 'sunken', min: 4.5 },
  // Boundaries
  { name: 'Input and switch edges on plates', fg: 'line-strong', bg: 'surface', min: 3 },
  { name: 'Input and switch edges on the page', fg: 'line-strong', bg: 'canvas', min: 3 },
  { name: 'Plate edges on the page', fg: 'edge', bg: 'canvas', min: 3 },
  { name: 'Plate edges on plates', fg: 'edge', bg: 'surface', min: 3 },
  { name: 'Focus ring on the page', fg: 'focus', bg: 'canvas', min: 3 },
  { name: 'Focus ring on plates', fg: 'focus', bg: 'surface', min: 3 },
  // Segmented and status-board cells draw focus inside the cell, on the chosen fill, in the
  // colour of the text on it (--on-chosen). --focus itself is hi-vis in Night and would vanish there.
  { name: 'Focus ring inside a chosen cell', fg: 'on-chosen', bg: 'chosen-fill', min: 3 },
  { name: 'Focus ring inside a chosen tab', fg: 'ink-accent', bg: 'ink', min: 3 },
  // Hi-vis: always ink text and an ink edge
  { name: 'Text on hi-vis', fg: 'on-hivis', bg: 'hivis', min: 4.5 },
  { name: 'Hi-vis edge against hi-vis', fg: 'hivis-edge', bg: 'hivis', min: 3 },
  { name: 'Secondary text on hi-vis', fg: 'ink-2', bg: 'hivis', min: 4.5, themes: ['day', 'sun'] },
  { name: 'Hi-vis against the dark page', fg: 'hivis', bg: 'canvas', min: 3, themes: ['night'] },
  { name: 'Text on the hi-vis wash', fg: 'ink', bg: 'hivis-wash', min: 4.5 },
  { name: 'Chosen value: text on the chosen fill', fg: 'on-chosen', bg: 'chosen-fill', min: 4.5 },
  { name: 'Chosen value: edge against the chosen fill', fg: 'chosen-edge', bg: 'chosen-fill', min: 3 },
  { name: 'Main action: text on its fill', fg: 'on-main', bg: 'main-fill', min: 4.5 },
  { name: 'Main action: hi-vis edge against its fill', fg: 'main-edge', bg: 'main-fill', min: 3, registers: ['field'] },
  // Ink fills (tabs, ink buttons, switches that are on, toasts) invert in Night
  { name: 'Text on ink fills', fg: 'on-ink', bg: 'ink', min: 4.5 },
  { name: 'Old white text on old teal (now ink)', fg: 'surface', bg: 'ink', min: 4.5 },
  { name: 'Toast tick and Undo on ink', fg: 'ink-accent', bg: 'ink', min: 4.5 },
  // Status
  { name: 'Signed tag', fg: 'on-ok', bg: 'ok', min: 4.5 },
  { name: 'OK text on plates', fg: 'ok', bg: 'surface', min: 4.5 },
  { name: 'OK text on its fill', fg: 'ok', bg: 'ok-fill', min: 4.5 },
  { name: 'Old white text on old green (now ok)', fg: 'surface', bg: 'ok', min: 4.5 },
  { name: 'Warn text on its fill', fg: 'warn', bg: 'warn-fill', min: 4.5 },
  { name: 'Warn text on plates', fg: 'warn', bg: 'surface', min: 4.5 },
  { name: 'Bad text on its fill', fg: 'bad', bg: 'bad-fill', min: 4.5 },
  { name: 'Bad text on plates', fg: 'bad', bg: 'surface', min: 4.5 },
  { name: 'Text on solid bad', fg: 'on-bad', bg: 'bad', min: 4.5 },
  { name: 'Old white text on old red (now bad)', fg: 'surface', bg: 'bad', min: 4.5 },
  { name: 'Sent tag', fg: 'info', bg: 'info-fill', min: 4.5 },
  { name: 'Info text on plates', fg: 'info', bg: 'surface', min: 4.5 },
  { name: 'Viewed tag', fg: 'viewed', bg: 'viewed-fill', min: 4.5 },
  { name: 'Draft and Expired tags', fg: 'ink-2', bg: 'draft-fill', min: 4.5 },
  { name: 'Hazard hatch stripes', fg: 'hazard', bg: 'on-hazard', min: 3 },
  { name: 'Text on hazard', fg: 'on-hazard', bg: 'hazard', min: 4.5 },
  // Roof map: every line on a 2px ink casing
  { name: 'Map casing on lawn', fg: 'e-casing', bg: MAP_GROUNDS.lawn, min: 3 },
  { name: 'Map casing on shingles', fg: 'e-casing', bg: MAP_GROUNDS.shingles, min: 3 },
  { name: 'Ridge line on its casing', fg: 'e-ridge', bg: 'e-casing', min: 3 },
  { name: 'Hip line on its casing', fg: 'e-hip', bg: 'e-casing', min: 3 },
  { name: 'Valley line on its casing', fg: 'e-valley', bg: 'e-casing', min: 3 },
  { name: 'Eave line on its casing', fg: 'e-eave', bg: 'e-casing', min: 3 },
  { name: 'Rake line on its casing', fg: 'e-rake', bg: 'e-casing', min: 3 },
  { name: 'Pitch-break line on its casing', fg: 'e-break', bg: 'e-casing', min: 3 },
  { name: 'Face numbers', fg: 'on-face-badge', bg: 'face-badge', min: 4.5 },
  { name: 'Text on photo frames', fg: 'on-frame', bg: 'frame', min: 4.5 },
];

export const THEMES: readonly ThemeName[] = ['day', 'night', 'sun'];
export const REGISTERS: readonly RegisterName[] = ['field', 'quiet'];

export function pairApplies(p: ContrastPair, theme: ThemeName, register: RegisterName): boolean {
  return (!p.themes || p.themes.includes(theme)) && (!p.registers || p.registers.includes(register));
}

/** Resolves a token through var() references in a flat token map; null when not a colour. */
export function resolveToken(ref: ColorRef, tokens: Readonly<Record<string, string>>, depth = 0): string | null {
  if (ref.startsWith('#')) return ref;
  const raw = tokens[ref];
  if (raw === undefined || depth > 8) return null;
  const v = /^var\(--([a-z0-9-]+)\)$/i.exec(raw.trim());
  return v ? resolveToken(v[1]!, tokens, depth + 1) : raw.trim();
}

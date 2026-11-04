// Ported from AtticScan (atticscan.vercel.app). Pure.
// Length parsing and formatting. Field crews type lengths many ways, so every input accepts:
//   24'6"   24' 6"   24'6   24ft 6in   24.5   24.5'   294"   294in   24 6   24'6 1/2"   6 1/2"
// A bare number is feet. "24 6" (two numbers) is feet then inches, which saves hunting for the
// ' and " keys on a phone keyboard. Smart quotes from iOS (’ ” ′ ″) are accepted too.

/** Normalises iOS smart quotes, primes and spacing so the patterns below stay simple. */
function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[’‘′`´]/g, "'")
    .replace(/[”“″]/g, '"')
    .replace(/''/g, '"')
    .replace(/\s*(feet|foot|ft)\.?/g, "'")
    .replace(/\s*(inches|inch|in)\.?/g, '"')
    .replace(/\s+/g, ' ');
}

const NUM = String.raw`\d+(?:\.\d+)?|\.\d+`;
// Inches: "6", "6.5", "1/2" or "6 1/2".
const INCHES = String.raw`(${NUM})?(?:\s*(\d+)\/(\d+))?`;

function inchesValue(whole?: string, num?: string, den?: string): number | null {
  let v = whole ? Number(whole) : 0;
  if (num && den) {
    if (Number(den) === 0) return null;
    v += Number(num) / Number(den);
  }
  return v;
}

/**
 * Parses a length and returns feet, or null when the text isn't a valid length.
 * Empty text returns null as well; callers decide whether empty is an error.
 */
export function parseFeet(text: string): number | null {
  const s = normalise(text);
  if (!s) return null;

  // Feet with optional inches: 24'  24'6  24'6"  24' 6 1/2"
  let m = new RegExp(String.raw`^(${NUM})\s*'\s*(?:${INCHES}\s*"?)?$`).exec(s);
  if (m) {
    const inches = inchesValue(m[2], m[3], m[4]);
    if (inches === null || inches >= 12) return null;
    return Number(m[1]) + inches / 12;
  }
  // Inches only: 294"  6 1/2"  1/2"
  m = new RegExp(String.raw`^${INCHES}\s*"$`).exec(s);
  if (m && (m[1] || m[2])) {
    const inches = inchesValue(m[1], m[2], m[3]);
    return inches === null ? null : inches / 12;
  }
  // Two bare numbers: feet then inches ("24 6", "24 6 1/2")
  m = new RegExp(String.raw`^(\d+)\s+${INCHES}$`).exec(s);
  if (m && (m[2] || m[3])) {
    const inches = inchesValue(m[2], m[3], m[4]);
    if (inches === null || inches >= 12) return null;
    return Number(m[1]) + inches / 12;
  }
  // Bare number: feet
  m = new RegExp(String.raw`^(${NUM})$`).exec(s);
  if (m) return Number(m[1]);
  return null;
}

/** Parses a plain number such as a count or a percentage. */
export function parseNumber(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses a roof pitch given as rise per 12 of run: "6", "6/12", "6:12", "7.5/12".
 * Returns the rise (inches per foot), or null.
 */
export function parsePitch(text: string): number | null {
  const s = text.trim().replace(/\s+/g, '');
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?|\.\d+)(?:[/:](\d+(?:\.\d+)?))?$/.exec(s);
  if (!m) return null;
  const rise = Number(m[1]);
  const run = m[2] ? Number(m[2]) : 12;
  if (run <= 0) return null;
  return (rise / run) * 12;
}

/** Feet as feet-inches to the nearest inch: 24.5 → 24' 6". */
export function formatFeet(feet: number): string {
  if (!Number.isFinite(feet)) return '—';
  const sign = feet < 0 ? '-' : '';
  let totalInches = Math.round(Math.abs(feet) * 12);
  const ft = Math.floor(totalInches / 12);
  totalInches -= ft * 12;
  if (ft === 0) return `${sign}${totalInches}"`;
  return totalInches ? `${sign}${ft}' ${totalInches}"` : `${sign}${ft}'`;
}

/** Square feet, whole numbers with thousands separators: 1234.4 → "1,234". */
export function formatSqft(sqft: number): string {
  if (!Number.isFinite(sqft)) return '—';
  return Math.round(sqft).toLocaleString('en-US');
}

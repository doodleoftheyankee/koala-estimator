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

/** The steepest roof pitch taken, as rise per 12 (about 63.4°). Anything steeper is a typing mistake. */
export const MAX_RISE = 24;
/** 24/12 as an angle: 63.4°. */
const MAX_DEGREES = (Math.atan(MAX_RISE / 12) * 180) / Math.PI;

const PITCH_NUM = String.raw`\d+(?:\.\d+)?|\.\d+`;
/** 30°  30º  30˚  30deg  30 degrees (spaces are taken out first). */
const DEGREES_RE = new RegExp(String.raw`^(${PITCH_NUM})(?:°|º|˚|deg(?:ree)?s?\.?)$`, 'i');
const RISE_RE = new RegExp(String.raw`^(${PITCH_NUM})(?:[/:](${PITCH_NUM}))?$`);
const BARE_RE = new RegExp(String.raw`^(${PITCH_NUM})$`);

/** A typed pitch: its rise per 12, and the angle when it was typed in degrees. */
export type PitchRead = { ok: true; rise: number; degrees: number | null } | { ok: false; error: string };

const riseOf = (degrees: number) => 12 * Math.tan((degrees * Math.PI) / 180);
const angleOf = (rise: number) => (Math.atan(rise / 12) * 180) / Math.PI;
const tenth = (n: number) => String(Math.round(n * 10) / 10);
const PITCH_HELP = 'Type the rise per 12, e.g. 6/12, or degrees, e.g. 30°.';

/**
 * Reads a roof pitch: rise per 12 ("6", "6/12", "6:12", "7.5/12", "3/6") or degrees ("30°",
 * "30 deg", "30 degrees"). Nothing steeper than 24/12 is taken: a bare number over 24 is refused
 * with a hint (as degrees when that reading is a real roof). `label` names the field in the message.
 * Null for empty text; callers say what to enter.
 */
export function readPitch(text: string, label = 'Pitch'): PitchRead | null {
  const s = text.trim().replace(/\s+/g, '');
  if (!s) return null;
  const shown = text.trim();
  const deg = DEGREES_RE.exec(s);
  if (deg) {
    const degrees = Number(deg[1]);
    if (degrees > MAX_DEGREES) return { ok: false, error: `${label} "${shown}" is steeper than 24/12 (${tenth(MAX_DEGREES)}°). Check the angle.` };
    return { ok: true, rise: riseOf(degrees), degrees };
  }
  const m = RISE_RE.exec(s);
  if (!m) return { ok: false, error: `${label} "${shown}" isn't valid. ${PITCH_HELP}` };
  const run = m[2] ? Number(m[2]) : 12;
  if (!(run > 0)) return { ok: false, error: `${label} "${shown}" isn't valid. ${PITCH_HELP}` };
  const rise = (Number(m[1]) / run) * 12;
  if (rise > MAX_RISE) {
    if (m[2]) return { ok: false, error: `${label} "${shown}" is steeper than 24/12. Check the numbers.` };
    const asDegrees = degreesSuggestion(s);
    return {
      ok: false,
      error: asDegrees ? `${label} "${shown}" would be ${m[1]}/12, steeper than 24/12. For degrees, type ${asDegrees}.` : `${label} "${shown}" would be ${m[1]}/12, steeper than 24/12. ${PITCH_HELP}`,
    };
  }
  return { ok: true, rise, degrees: null };
}

/**
 * Parses a roof pitch and returns the rise per 12 (inches per foot), or null when it isn't a
 * pitch or is steeper than 24/12. See readPitch for the forms taken and the messages.
 */
export function parsePitch(text: string): number | null {
  const r = readPitch(text);
  return r?.ok ? r.rise : null;
}

/**
 * A bare number that reads as a very steep roof (over 12/12) may have been meant as degrees: the
 * same number with a degree sign, when that angle is a pitch this takes ("30" gives "30°"). Null
 * for anything else (a pitch with a slash or a degree sign, 12 or less, or an angle over 24/12).
 */
export function degreesSuggestion(text: string): string | null {
  const s = text.trim().replace(/\s+/g, '');
  if (!BARE_RE.test(s)) return null;
  const n = Number(s);
  return n > 12 && n <= MAX_DEGREES ? `${s}°` : null;
}

/** How a bare number over 12 is read, for a note under the pitch: "Pitch 18 is read as 18/12, a very steep roof (56.3°). If you meant 18°, type 18°." */
export function steepPitchNote(text: string, label = 'Pitch'): string | null {
  const asDegrees = degreesSuggestion(text);
  const r = readPitch(text, label);
  if (!asDegrees || !r?.ok) return null;
  const s = text.trim();
  return `${label} ${s} is read as ${s}/12, a very steep roof (${tenth(angleOf(r.rise))}°). If you meant ${asDegrees}, type ${asDegrees}.`;
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

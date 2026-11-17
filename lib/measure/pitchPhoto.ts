// Roof pitch from a photo of a gable end, ported from the Roof Takeoff page's step 1. Pure.
// The estimator taps the left eave corner, the peak and the right eave corner, all on the same edge.
// The line between the two eave corners sets level, so a phone turned a little sideways doesn't
// matter; a phone tipped back does (the gable is foreshortened and reads low on both sides, so the
// sides still agree): the sheet says to hold it upright. Pitch = rise over half the span × 12.
import { pitchFactor } from './measure';

export interface Pt {
  x: number;
  y: number;
}

export type PitchReading =
  | { bad: true }
  | {
      bad: false;
      /** Rise per 12 over the whole gable (rise over half the span). */
      pitch: number;
      /** Rise per 12 of each side on its own. */
      left: number;
      right: number;
      /** Where a plumb line from the peak meets the eave-to-eave line. */
      foot: Pt;
    };

/** Pitch from the three taps, in image pixels. `bad` when they don't make a roof triangle. */
export function pitchFrom(L: Pt, P: Pt, R: Pt): PitchReading {
  const bx = R.x - L.x;
  const by = R.y - L.y;
  const span = Math.hypot(bx, by);
  if (span < 4) return { bad: true };
  const ux = bx / span;
  const uy = by / span;
  const vx = P.x - L.x;
  const vy = P.y - L.y;
  const along = vx * ux + vy * uy;
  const h = Math.abs(ux * vy - uy * vx);
  const runL = along;
  const runR = span - along;
  if (h < 1 || runL <= 0 || runR <= 0) return { bad: true };
  return { bad: false, pitch: (24 * h) / span, left: (12 * h) / runL, right: (12 * h) / runR, foot: { x: L.x + ux * along, y: L.y + uy * along } };
}

/** The two sides agree when they read less than this far apart (rise per 12). */
export const SIDES_AGREE = 0.75;

/** One decimal, the way every reading is shown: 6.25 → "6.3". */
export const fmt1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** Rise per 12 → the roof's angle in degrees. 6/12 → 26.6°. */
export const pitchDegrees = (rise: number) => (Math.atan(rise / 12) * 180) / Math.PI;

/** `text` goes under the reading; `short` stays in view next to the Use buttons. */
export type PitchCheck = { tone: 'idle' | 'ok' | 'warn' | 'bad'; text: string; short: string };

/** The line under the reading: waiting for taps, both sides agree, retake, or not a roof triangle. */
export function pitchCheck(r: PitchReading | null): PitchCheck {
  if (!r) return { tone: 'idle', text: 'Tap three points to read the pitch.', short: 'Tap the three points first.' };
  if (r.bad) return { tone: 'bad', text: "Those points don't make a roof triangle. The peak has to sit above and between the two corners.", short: 'Move the points to make a roof triangle.' };
  if (Math.abs(r.left - r.right) < SIDES_AGREE) return { tone: 'ok', text: 'Both sides agree. A phone tipped back reads low on both sides, so shoot with it upright.', short: '✓ Both sides agree.' };
  return {
    tone: 'warn',
    text: `Sides read ${fmt1(r.left)}/12 and ${fmt1(r.right)}/12. Retake from straight in front, unless this gable really has unequal sides.`,
    short: "The sides don't agree. Retake from straight in front?",
  };
}

/** What the reading shows: pitch and sides as "6.3", the angle and the pitch factor. */
export function pitchFacts(r: Extract<PitchReading, { bad: false }>): { pitch: string; degrees: string; factor: string; left: string; right: string } {
  return { pitch: fmt1(r.pitch), degrees: fmt1(pitchDegrees(r.pitch)), factor: pitchFactor(r.pitch).toFixed(3), left: fmt1(r.left), right: fmt1(r.right) };
}

/**
 * The pitch text the Use buttons write into the field: the nearest whole pitch ("6/12"), and the
 * reading to one decimal ("6.3/12") when that is different.
 */
export function pitchChoices(pitch: number): { rounded: string; measured: string | null } {
  const round = Math.round(pitch);
  const one = fmt1(pitch);
  return { rounded: `${round}/12`, measured: one === round.toFixed(1) ? null : `${one}/12` };
}

/** "How to shoot the gable". Tipping the phone back is the one tilt that skews the reading. */
export const PITCH_TIPS = [
  'Stand straight in front of the gable end. Shooting from off to the side makes the pitch read steep.',
  'Hold the phone upright, not tipped back. Tipping it up to fit the roof in makes the pitch read low, on both sides alike.',
  'Back up (and zoom in) until the whole gable fits with the phone upright. Distance also cuts down lens distortion.',
  'Turning the phone a little sideways is fine: the line between the two bottom corners sets level.',
  'Tap the same edge at all three points, such as the top of the rake trim.',
  'Hip roof with no gable? Use a garage or dormer gable with the same pitch.',
] as const;

/** The hint under the photo after `placed` points (0 to 3). */
export function pitchHint(placed: number): { step: string | null; text: string } {
  return (
    [
      { step: 'Tap 1 of 3', text: 'the left eave corner, on the top edge of the rake trim.' },
      { step: 'Tap 2 of 3', text: 'the peak, on that same edge.' },
      { step: 'Tap 3 of 3', text: 'the right eave corner, on the same edge.' },
    ][placed] ?? { step: null, text: 'Drag any point to fine-tune it. A magnifier shows while you drag.' }
  );
}

/** Photos are shrunk in the browser to at most this many pixels on the long side. */
export const MAX_PHOTO_SIDE = 2400;

/** Pixel size of a photo after shrinking it to `maxSide` on its long side (never enlarged). */
export function shrunkSize(width: number, height: number, maxSide = MAX_PHOTO_SIDE): { width: number; height: number } {
  const k = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** The point nearest `p` within `radius`, as its index, or -1. */
export function nearestPoint(points: readonly Pt[], p: Pt, radius: number): number {
  let hit = -1;
  let best = radius;
  points.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best) {
      best = d;
      hit = i;
    }
  });
  return hit;
}

/** Keeps a point on the photo. */
export const clampPt = (p: Pt, width: number, height: number): Pt => ({ x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) });

export interface Loupe {
  /** Centre and radius of the magnifier on the board, in screen pixels. */
  cx: number;
  cy: number;
  r: number;
  /** Screen pixels per photo pixel inside the magnifier. */
  scale: number;
  /** The part of the photo shown (photo pixels) and where it goes on the board; null when none of it is on the photo. */
  src: { x: number; y: number; w: number; h: number } | null;
  dst: { x: number; y: number; w: number; h: number };
}

/**
 * The magnifier shown while a point is dragged, since a finger hides the point: 4× the board's
 * zoom, in the top corner away from the point. `boardScale` is screen pixels per photo pixel.
 */
export function loupeFor(pt: Pt, photo: { width: number; height: number }, boardWidth: number, boardScale: number): Loupe {
  const r = Math.max(40, Math.min(66, boardWidth / 5));
  const scale = boardScale * 4;
  const cx = pt.x * boardScale < boardWidth / 2 ? boardWidth - r - 12 : r + 12;
  const cy = r + 12;
  let sx = pt.x - r / scale;
  let sy = pt.y - r / scale;
  let sw = (2 * r) / scale;
  let sh = (2 * r) / scale;
  let dx = cx - r;
  let dy = cy - r;
  let dw = 2 * r;
  let dh = 2 * r;
  if (sx < 0) {
    dx -= sx * scale;
    dw += sx * scale;
    sw += sx;
    sx = 0;
  }
  if (sy < 0) {
    dy -= sy * scale;
    dh += sy * scale;
    sh += sy;
    sy = 0;
  }
  if (sx + sw > photo.width) {
    const o = sx + sw - photo.width;
    sw -= o;
    dw -= o * scale;
  }
  if (sy + sh > photo.height) {
    const o = sy + sh - photo.height;
    sh -= o;
    dh -= o * scale;
  }
  return { cx, cy, r, scale, src: sw > 0 && sh > 0 ? { x: sx, y: sy, w: sw, h: sh } : null, dst: { x: dx, y: dy, w: dw, h: dh } };
}

/** Why a picked file can't be used, before trying to open it; null when it may be a photo. */
export function photoFileProblem(file: { type: string; name: string }): string | null {
  if (file.type && !file.type.startsWith('image/')) return "That file isn't a photo. Pick a JPG or PNG, or take a photo.";
  return null;
}

/** The message when the browser can't open a picked photo. HEIC (iPhone's own format) gets its own. */
export function photoOpenFailed(file: { type: string; name: string }): string {
  if (/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
    return "This browser can't open HEIC photos. Take a new photo with the camera instead, or pick a JPG. On an iPhone, Settings › Camera › Formats › Most Compatible saves JPGs.";
  }
  return "Couldn't open that photo. Try another one, or take a new photo.";
}

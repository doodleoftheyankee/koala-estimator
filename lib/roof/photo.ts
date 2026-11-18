// What the roof takeoff screens say about the aerial photo, worked out from the lookup itself:
// the scale bar on the photo, the source line under the numbers, and the house-check state.
// Pure (no DOM), so it is tested on the Roof Takeoff fixtures (photo.test.ts).
import { FT_PER_M, imageryText, MAP_SIZE, mapFrame, mapZoom, metersBetween, QUALITY_WORDS, type RoofResult } from './lookup';

/** Scale bar lengths, in feet: a bar always shows one of these round lengths. */
const SCALE_STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000] as const;
/** The bar takes about this share of the photo's width (never more). */
const SCALE_SHARE = 0.25;

export interface ScaleBar {
  /** The bar's length in feet (a round number from SCALE_STEPS). */
  feet: number;
  /** The bar's width as a share of the photo's width on screen (0 to 1). */
  share: number;
}

/**
 * The scale bar for the photo as shown: Google's static photos are north-up Web Mercator, so the
 * feet across the photo come from the map frame itself. `magnify` is how much the screen enlarges
 * the middle of the photo (mapShapes().magnify; 1 while picking the right roof).
 */
export function scaleBar(r: Pick<RoofResult, 'center' | 'box'>, magnify = 1): ScaleBar | null {
  const view = mapFrame(r.center, mapZoom(r.box));
  const left = view.toLatLng(0, MAP_SIZE / 2);
  const right = view.toLatLng(MAP_SIZE, MAP_SIZE / 2);
  const feetAcross = (metersBetween(left, right) * FT_PER_M) / Math.max(1, magnify);
  if (!Number.isFinite(feetAcross) || feetAcross <= 0) return null;
  const fits = SCALE_STEPS.filter((ft) => ft / feetAcross <= SCALE_SHARE);
  const feet = fits.at(-1);
  return feet ? { feet, share: feet / feetAcross } : null;
}

export type PhotoQuality = { label: string; tone: 'ok' | 'draft' | 'warn' };

/** The photo's detail in words ("Good photo"), with a tone for its tag; null when not known. */
export function photoQuality(r: Pick<RoofResult, 'quality'>): PhotoQuality | null {
  const q = r.quality ? QUALITY_WORDS[r.quality] : undefined;
  if (!q) return null;
  return {
    label: q.label,
    tone: q.tone === 'green' ? 'ok' : q.tone === 'amber' ? 'warn' : 'draft',
  };
}

/** "Aerial photo · Jun 2023": where the numbers come from and how old the photo is. */
export function sourceLine(r: Pick<RoofResult, 'imagery'>): string {
  return `Aerial photo · ${imageryText(r) ?? 'date unknown'}`;
}

/**
 * Where the house check stands, for the chip on the photo and the question under it:
 *   tap      picking the right roof on the photo
 *   check    Google placed the address roughly (or a roof was tapped): the estimator must say
 *   checked  the estimator said this is the house
 *   found    Google matched the house itself
 */
export type HouseState = 'tap' | 'check' | 'checked' | 'found';

export function houseState(r: Pick<RoofResult, 'precision'>, confirmed: boolean, picking: boolean): HouseState {
  if (picking) return 'tap';
  if (r.precision === 'ROOFTOP') return 'found';
  return confirmed ? 'checked' : 'check';
}

export const HOUSE_CHIP: Record<HouseState, string> = {
  tap: 'Tap the right roof',
  check: 'Check the house',
  checked: 'Right house',
  found: 'House found',
};

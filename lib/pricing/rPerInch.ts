// What is already in a cavity, and how much room it leaves: the one R-per-inch table for existing
// insulation (S2-F19), shared by the pricing engine and the AI photo read, and the cavity a wall
// has when no depth was entered (OD5). Pure, no I/O.
import type { AreaInput } from './types';

/** Existing-insulation choices in the area form; the photo read picks from the same list. */
export const EXISTING_MATERIALS = ['None', 'Fiberglass batts', 'Blown fiberglass', 'Cellulose', 'Rock wool', 'Vermiculite', 'Spray foam', 'Other'] as const;
export type ExistingMaterial = (typeof EXISTING_MATERIALS)[number];

/**
 * Typical R per inch of insulation already in place (S2-F19: one table). The materials the company
 * installs read the same as its products (fiberglass batts 3.2, blown fiberglass 2.5, cellulose
 * 3.6, open-cell spray foam 3.7); rock wool 3.1 and vermiculite 2.1 are typical mid values.
 * "Other" is 3.2, the middle of the common fibrous materials, until the owner says otherwise.
 */
export const EXISTING_R_PER_INCH: Readonly<Record<ExistingMaterial, number>> = {
  None: 0,
  'Fiberglass batts': 3.2,
  'Blown fiberglass': 2.5,
  Cellulose: 3.6,
  'Rock wool': 3.1,
  Vermiculite: 2.1,
  'Spray foam': 3.7,
  Other: 3.2,
};

/** OD5: a wall with no depth entered is a 2x4 wall, a 3.5 in cavity. */
export const DEFAULT_WALL_CAVITY_IN = 3.5;

/**
 * Less room than this is a full cavity: nothing more can be blown, sprayed or laid in it
 * (cavity_full). Half an inch: an R-11 batt (3.4 in at 3.2 per inch) fills a 3.5 in wall.
 */
export const MIN_ROOM_IN = 0.5;

/** The table's material for a name typed in any case; null when it is not one of them. */
export function existingMaterialNamed(name: string | null | undefined): ExistingMaterial | null {
  const n = name?.trim().toLowerCase() ?? '';
  return EXISTING_MATERIALS.find((m) => m.toLowerCase() === n) ?? null;
}

/** The highest R per inch in the table: how an unknown material is read. */
const HIGHEST_R_PER_INCH = Math.max(...Object.values(EXISTING_R_PER_INCH));

/**
 * R per inch of the insulation already in an area, by name in any case. A material that is not
 * named, not in the table, or "None" with an R-value is read at the highest R per inch in the
 * table (3.7): its R then takes the least room, so the room left is never understated and a fill
 * that says it fills the cavity does (the accuracy check reads it the same way).
 */
export function existingRPerInch(material: string | null | undefined): number {
  const known = existingMaterialNamed(material);
  const r = known ? EXISTING_R_PER_INCH[known] : 0;
  return r > 0 ? r : HIGHEST_R_PER_INCH;
}

/**
 * The cavity the insulation has to fit in, in inches: the depth entered, or a 2x4 wall (3.5 in)
 * for walls with none (OD5). Null when there is no cavity to fill (an open attic floor, or a
 * framed area whose depth was not entered).
 */
export function cavityDepth(area: Pick<AreaInput, 'jobType' | 'depthIn'>): number | null {
  if (area.depthIn !== null && Number.isFinite(area.depthIn) && area.depthIn > 0) return area.depthIn;
  return area.jobType === 'walls' ? DEFAULT_WALL_CAVITY_IN : null;
}

/** How thick the insulation already in the area is, in inches: the depth entered, else its R over its R per inch. */
export function existingThicknessIn(area: Pick<AreaInput, 'currentR' | 'existingMaterial' | 'existingDepthIn'>): number {
  if (area.existingDepthIn !== null && Number.isFinite(area.existingDepthIn) && area.existingDepthIn > 0) return area.existingDepthIn;
  if (area.currentR > 0) return area.currentR / existingRPerInch(area.existingMaterial);
  return 0;
}

/**
 * The R-value of the insulation already in an area, worked out from its type and depth: depth x
 * the table's R per inch, to a whole number (4 in of blown fiberglass = R-10). Null when either is
 * missing, or the type is "None" or not in the table: then nothing can be worked out.
 */
export function currentRFromDepth(material: string | null | undefined, depthIn: number | null | undefined): number | null {
  const known = existingMaterialNamed(material);
  if (!known || known === 'None') return null;
  if (depthIn === null || depthIn === undefined || !Number.isFinite(depthIn) || depthIn <= 0) return null;
  return Math.round(depthIn * EXISTING_R_PER_INCH[known]);
}

/**
 * A change to the existing insulation's type or depth, with the current R-value it implies
 * (readiness walk W3: typing 4 in of blown fiberglass left R-0, so the area was priced as if
 * empty). The R-value follows the type and depth while it is 0 or still the value they gave;
 * one the estimator typed (from a label) is never overwritten.
 */
export function withExistingChange<A extends Pick<AreaInput, 'currentR' | 'existingMaterial' | 'existingDepthIn'>>(
  area: A,
  change: Partial<Pick<AreaInput, 'existingMaterial' | 'existingDepthIn'>>,
): Partial<Pick<AreaInput, 'currentR' | 'existingMaterial' | 'existingDepthIn'>> {
  const before = currentRFromDepth(area.existingMaterial, area.existingDepthIn);
  const next = { ...area, ...change };
  const after = currentRFromDepth(next.existingMaterial, next.existingDepthIn);
  const followsTypeAndDepth = area.currentR === 0 || (before !== null && area.currentR === before);
  if (!followsTypeAndDepth) return change;
  if (after !== null) return { ...change, currentR: after };
  // The type or depth was cleared: an R-value that came from them goes with them.
  return before !== null && area.currentR === before ? { ...change, currentR: 0 } : change;
}

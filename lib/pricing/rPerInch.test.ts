// Readiness walk W3: the existing insulation's type and depth give the current R-value, so an area
// with 4 in of blown fiberglass is not priced as if it were empty.
import { describe, expect, it } from 'vitest';
import { currentRFromDepth, withExistingChange } from './rPerInch';

const area = (over: Partial<{ currentR: number; existingMaterial: string | null; existingDepthIn: number | null }> = {}) => ({
  currentR: 0,
  existingMaterial: null as string | null,
  existingDepthIn: null as number | null,
  ...over,
});

describe('currentRFromDepth', () => {
  it('is depth times the R per inch of the type, to a whole number', () => {
    expect(currentRFromDepth('Blown fiberglass', 4)).toBe(10);
    expect(currentRFromDepth('Fiberglass batts', 3.5)).toBe(11);
    expect(currentRFromDepth('cellulose', 6)).toBe(22);
  });
  it('is null when the type or depth is missing, or the type is None or unknown', () => {
    expect(currentRFromDepth(null, 4)).toBeNull();
    expect(currentRFromDepth('None', 4)).toBeNull();
    expect(currentRFromDepth('Straw', 4)).toBeNull();
    expect(currentRFromDepth('Cellulose', null)).toBeNull();
    expect(currentRFromDepth('Cellulose', 0)).toBeNull();
  });
});

describe('withExistingChange (readiness walk W3)', () => {
  it('fills in the R-value when the type and depth are both given, in either order', () => {
    const typed = withExistingChange(area(), { existingMaterial: 'Blown fiberglass' });
    expect(typed).toEqual({ existingMaterial: 'Blown fiberglass' });
    const both = withExistingChange(area(typed), { existingDepthIn: 4 });
    expect(both).toEqual({ existingDepthIn: 4, currentR: 10 });
    const depthFirst = withExistingChange(area({ existingDepthIn: 4 }), { existingMaterial: 'Cellulose' });
    expect(depthFirst).toEqual({ existingMaterial: 'Cellulose', currentR: 14 });
  });
  it('follows later changes to the type or depth while the R-value is still the one they gave', () => {
    const a = area({ existingMaterial: 'Blown fiberglass', existingDepthIn: 4, currentR: 10 });
    expect(withExistingChange(a, { existingDepthIn: 8 })).toEqual({ existingDepthIn: 8, currentR: 20 });
    expect(withExistingChange(a, { existingMaterial: 'Cellulose' })).toEqual({ existingMaterial: 'Cellulose', currentR: 14 });
    // Clearing the type or depth takes back the R-value that came from them.
    expect(withExistingChange(a, { existingDepthIn: null })).toEqual({ existingDepthIn: null, currentR: 0 });
    expect(withExistingChange(a, { existingMaterial: null })).toEqual({ existingMaterial: null, currentR: 0 });
  });
  it('never overwrites an R-value the estimator typed (a label)', () => {
    const labelled = area({ existingMaterial: 'Fiberglass batts', existingDepthIn: 3.5, currentR: 13 });
    expect(withExistingChange(labelled, { existingDepthIn: 6 })).toEqual({ existingDepthIn: 6 });
    expect(withExistingChange(labelled, { existingMaterial: null })).toEqual({ existingMaterial: null });
    const noDepth = area({ existingMaterial: 'Cellulose', currentR: 19 });
    expect(withExistingChange(noDepth, { existingDepthIn: 4 })).toEqual({ existingDepthIn: 4 });
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactTakeoff, MAP_SIZE, takeoffSchema } from './lookup';
import { mapShapes, satelliteUrl, svgPoints } from './draw';

const r = compactTakeoff(takeoffSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'roof-takeoff', '3-cross-gable.json'), 'utf8'))));

describe('mapShapes', () => {
  it('puts the outline, faces, edges and face numbers on the 640 x 640 photo', () => {
    const s = mapShapes(r, [5]);
    expect(s.zoom).toBe(20);
    expect(s.faces.map((f) => [f.n, f.out])).toEqual([[1, false], [2, false], [3, false], [4, false], [5, true]]);
    expect(s.edges).toHaveLength(r.edges.length);
    expect(s.edges.map((e) => e.type)).toContain('headwall');
    expect(s.labels.map((l) => l.n).sort()).toEqual([1, 2, 3, 4, 5]);
    const inside = (p: { x: number; y: number }) => p.x > 0 && p.x < MAP_SIZE && p.y > 0 && p.y < MAP_SIZE;
    for (const ring of s.outline) expect(ring.every(inside)).toBe(true);
    for (const e of s.edges) expect(e.pts.every(inside)).toBe(true);
    // The building's center is the middle of the photo.
    const middle = s.outline[0]!.reduce((a, p) => ({ x: a.x + p.x / s.outline[0]!.length, y: a.y + p.y / s.outline[0]!.length }), { x: 0, y: 0 });
    expect(Math.abs(middle.x - 320)).toBeLessThan(60);
    expect(Math.abs(middle.y - 320)).toBeLessThan(60);
  });

  it('numbers a face with no shape at Google’s middle of it', () => {
    const s = mapShapes({ ...r, faces: [] }, []);
    expect(s.faces).toEqual([]);
    expect(s.labels.map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it('writes SVG points and the photo address', () => {
    expect(svgPoints([{ x: 1, y: 2.25 }, { x: 3.333, y: 4 }])).toBe('1.0,2.3 3.3,4.0');
    expect(satelliteUrl(r)).toBe(`/api/roof/satellite?lat=${r.center.lat}&lng=${r.center.lng}&zoom=20`);
  });
});

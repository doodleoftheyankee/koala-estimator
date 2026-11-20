import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, MAP_GROUNDS, parseHex } from '@/lib/design/contrast';
import { compactTakeoff, EDGE_TYPES, MAP_SIZE, takeoffSchema } from './lookup';
import { edgeColor, insideShape, labelPoint, MAP_COLORS, mapShapes, paintRoofMap, satelliteUrl, svgPoints } from './draw';

const house = (name: string) => compactTakeoff(takeoffSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'roof-takeoff', `${name}.json`), 'utf8'))));
const r = house('3-cross-gable');

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

  it('enlarges a small roof, up to twice, keeping all of it on the photo', () => {
    const s = mapShapes(r, []);
    expect(s.magnify).toBeGreaterThan(1);
    expect(s.magnify).toBeLessThanOrEqual(2);
    const on = (p: { x: number; y: number }) => Math.abs((p.x - 320) * s.magnify) < 320 && Math.abs((p.y - 320) * s.magnify) < 320;
    for (const ring of s.outline) expect(ring.every(on)).toBe(true);
    // A roof that already fills the photo is not enlarged; nothing to draw, nothing enlarged.
    const big = mapShapes({ ...r, outline: [[{ lat: r.center.lat + 0.0004, lng: r.center.lng }, { lat: r.center.lat, lng: r.center.lng + 0.0005 }, { lat: r.center.lat - 0.0004, lng: r.center.lng }]] }, []);
    expect(big.magnify).toBe(1);
    expect(mapShapes({ ...r, outline: [], faces: [], edges: [], segments: [] }, []).magnify).toBe(1);
  });

  it("puts every face's number inside its own face, a notched one too", () => {
    for (const name of ['1-gable', '2-hip', '3-cross-gable', '4-low-detail', '5-twin', '6-flat', '7-cape', '7-cape-pin', '8-main-row']) {
      const s = mapShapes(house(name), []);
      for (const f of s.faces) {
        const at = s.labels.find((l) => l.n === f.n)!.at;
        expect(insideShape(f.pts, at), `${name} face ${f.n}`).toBe(true);
        // and not inside another face
        for (const other of s.faces) if (other.n !== f.n) expect(insideShape(other.pts, at), `${name} face ${f.n} on face ${other.n}`).toBe(false);
      }
    }
  });

  it('finds a point inside an L-shaped face, whose middle is outside it', () => {
    const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 100 }, { x: 0, y: 100 }];
    expect(insideShape(L, { x: 34, y: 34 })).toBe(false);
    expect(insideShape(L, labelPoint(L))).toBe(true);
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(labelPoint(square)).toEqual({ x: 5, y: 5 });
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

describe('map colours', () => {
  const css = readFileSync(join(import.meta.dirname, '../../app/globals.css'), 'utf8');
  const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1]?.toUpperCase();
  const rgb = (hex: string) => parseHex(hex)!;

  it('are the Daymark roof map tokens in app/globals.css', () => {
    expect(MAP_COLORS.casing).toBe(token('e-casing'));
    for (const k of ['ridge', 'hip', 'valley', 'eave', 'rake', 'break', 'step', 'headwall'] as const) expect(edgeColor(k), k).toBe(token(`e-${k}`));
    expect(MAP_COLORS.casing).toBe(token('face-badge'));
    expect(MAP_COLORS.light).toBe(token('on-face-badge'));
  });

  it('give every edge type its own colour that stands out from the ink casing', () => {
    expect(new Set(EDGE_TYPES.map(edgeColor)).size).toBe(EDGE_TYPES.length);
    for (const k of EDGE_TYPES) expect(contrastRatio(rgb(edgeColor(k)), rgb(MAP_COLORS.casing)), k).toBeGreaterThanOrEqual(4.5);
    // The casing itself stands out from lawn and shingles (a UI boundary: 3:1).
    for (const ground of Object.values(MAP_GROUNDS)) expect(contrastRatio(rgb(MAP_COLORS.casing), rgb(ground))).toBeGreaterThanOrEqual(3);
    // Face numbers: white on ink.
    expect(contrastRatio(rgb(MAP_COLORS.light), rgb(MAP_COLORS.casing))).toBeGreaterThan(19);
  });

  it('paint the printed photo: ink casing under each line, then its colour', () => {
    const calls: string[] = [];
    const g = new Proxy(
      {},
      {
        get: (_, key) => (key === 'setLineDash' || typeof key !== 'string' ? () => undefined : (...args: unknown[]) => calls.push(`${key}(${args.join(',')})`)),
        set: (_, key, value) => (calls.push(`${String(key)}=${value}`), true),
      },
    ) as unknown as CanvasRenderingContext2D;
    const shapes = mapShapes(r, [5]);
    paintRoofMap(g, 960, shapes, null, { font: 'Archivo' });
    const strokes = calls.filter((c) => c.startsWith('strokeStyle='));
    // The first edge: casing, then the edge's colour.
    const at = strokes.indexOf(`strokeStyle=${edgeColor(shapes.edges[0]!.type)}`);
    expect(at).toBeGreaterThan(0);
    expect(strokes[at - 1]).toBe(`strokeStyle=${MAP_COLORS.casing}`);
    expect(calls).toContain(`fillStyle=${MAP_COLORS.casing}`);
    expect(calls.find((c) => c.startsWith('font='))).toMatch(/^font=800 .*px Archivo$/);
  });
});

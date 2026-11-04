// Screen layout for a measured shape: fit it to a box and place a length label beside every
// side without labels overlapping each other or the outline. Pure (no DOM), so it's testable.
import { signedArea, type Edge, type Point, type SolvedShape } from './geometry';
import { formatFeet } from './units';

export interface EdgeLabel {
  x: number;
  y: number;
  text: string;
  /** Runs along a steep side (rotate −90° about x,y). */
  vertical: boolean;
  /** Carries an input letter (A–D) or side number; drawn bold. */
  lettered: boolean;
}

export interface ShapeLayout {
  /** SVG path data for the outline. */
  path: string;
  labels: EdgeLabel[];
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Liang–Barsky: does segment a→b pass through box r? */
function segmentHitsBox(a: Point, b: Point, r: Box): boolean {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const tests: Array<[number, number]> = [[-dx, a[0] - r.x0], [dx, r.x1 - a[0]], [-dy, a[1] - r.y0], [dy, r.y1 - a[1]]];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** An unlettered side that just mirrors a lettered one (same length, parallel) adds clutter. */
function isEcho(e: Edge, lettered: Edge[]): boolean {
  if (e.label) return false;
  return lettered.some((l) => {
    const cross = (e.to[0] - e.from[0]) * (l.to[1] - l.from[1]) - (e.to[1] - e.from[1]) * (l.to[0] - l.from[0]);
    return Math.abs(l.length - e.length) < 1e-6 && Math.abs(cross) < 1e-6 * Math.max(1, e.length * l.length);
  });
}

/**
 * Fits the shape into width × height (with padding for labels) and labels each side: lettered
 * sides as "A 24' 6"", the rest with their computed length. Lettered labels are placed first;
 * a label that would collide slides along its side, then steps further out, until it's clear.
 * Text boxes are estimated (~7.6px per character at 13px bold).
 */
export function layoutShape(shape: SolvedShape, width = 320, height = 240, pad = 40): ShapeLayout {
  const xs = shape.points.map((p) => p[0]);
  const ys = shape.points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((width - 2 * pad) / Math.max(maxX - minX, 1e-6), (height - 2 * pad) / Math.max(maxY - minY, 1e-6));
  const offX = (width - (maxX - minX) * scale) / 2;
  const offY = (height - (maxY - minY) * scale) / 2;
  // Feet → screen, flipping y so "up" in the plan is up on screen.
  const tx = (p: Point): Point => [offX + (p[0] - minX) * scale, height - offY - (p[1] - minY) * scale];

  const path = shape.points.map((p, i) => `${i ? 'L' : 'M'}${tx(p).map((v) => v.toFixed(1)).join(' ')}`).join(' ') + 'Z';

  const ccw = signedArea(shape.points) > 0;
  const lettered = shape.edges.filter((e) => e.label && !e.label.startsWith('#'));
  const segments = shape.edges.map((e) => [tx(e.from), tx(e.to)] as const);
  const placed: Box[] = [];
  const clear = (b: Box) =>
    !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0) && !segments.some(([a, c]) => segmentHitsBox(a, c, b));

  const labels: EdgeLabel[] = [];
  const order = [...shape.edges].sort((a, b) => Number(!a.label) - Number(!b.label));
  for (const e of order) {
    if (e.length < 1e-6 || isEcho(e, lettered)) continue;
    const [x1, y1] = tx(e.from);
    const [x2, y2] = tx(e.to);
    // Outward normal on screen: flipping y turns a counter-clockwise plan clockwise on screen,
    // where (−dy, dx) points outward; a clockwise sketch needs the opposite.
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const sign = ccw ? 1 : -1;
    const nx = (-dy * sign) / len, ny = (dx * sign) / len;
    const ux = dx / len, uy = dy / len;
    const text = e.label ? `${e.label} ${formatFeet(e.length)}` : formatFeet(e.length);
    const vertical = Math.abs(dy) > Math.abs(dx);
    const w = text.length * 7.6, h = 15;
    const boxAt = (cx: number, cy: number): Box =>
      vertical ? { x0: cx - h / 2, y0: cy - w / 2, x1: cx + h / 2, y1: cy + w / 2 } : { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    const cx0 = (x1 + x2) / 2, cy0 = (y1 + y2) / 2;
    let x = cx0 + nx * 16, y = cy0 + ny * 16;
    search: for (const off of [16, 28, 40]) {
      for (let t = 0; t <= len / 2 + w / 2; t += 4) {
        for (const tt of t ? [t, -t] : [0]) {
          const px = cx0 + nx * off + ux * tt, py = cy0 + ny * off + uy * tt;
          if (clear(boxAt(px, py))) {
            x = px;
            y = py;
            break search;
          }
        }
      }
    }
    placed.push(boxAt(x, y));
    labels.push({ x, y, text, vertical, lettered: Boolean(e.label) });
  }
  return { path, labels };
}

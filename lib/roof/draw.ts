// What goes on the aerial photo, in the photo's own 640 x 640 frame: the roof faces (the ones left
// out shaded), the outline, the roof edges in their colours and each face's number. The screen
// draws these shapes as SVG (app/field/measure/RoofTakeoff); the printed report paints them onto a
// canvas with paintRoofMap. mapShapes is pure; paintRoofMap needs only a 2D canvas context.
import { MAP_SIZE, mapFrame, mapZoom, type EdgeType, type RoofResult } from './lookup';
import { EDGE_INFO, OUTLINE_COLOR } from './roofing';

export interface Pt {
  x: number;
  y: number;
}

export interface MapShapes {
  zoom: number;
  /** Each face's shape; `out` = left out (shaded). */
  faces: Array<{ n: number; pts: Pt[]; out: boolean }>;
  outline: Pt[][];
  edges: Array<{ type: EdgeType; pts: Pt[] }>;
  /** Where each face's number goes: inside its shape (labelPoint), or Google's middle of the face. */
  labels: Array<{ n: number; at: Pt; out: boolean }>;
  /** Where Google placed the address (or the spot looked up). */
  point: Pt;
  /**
   * How much to enlarge the middle of the photo so a small roof fills it (1 to 2): the photo is
   * at most Google's closest zoom, where a small house is only a fifth of it wide.
   */
  magnify: number;
}

/** The roof's farthest point from the middle of the photo may reach this share of the half-width once enlarged. */
const FILL = 0.6;
const MAX_MAGNIFY = 2;

/** The aerial photo behind a result (the app's own signed-in proxy, so a canvas can use it). */
export function satelliteUrl(r: Pick<RoofResult, 'center' | 'box'>): string {
  return `/api/roof/satellite?${new URLSearchParams({ lat: String(r.center.lat), lng: String(r.center.lng), zoom: String(mapZoom(r.box)) })}`;
}

/** Whether a point is inside a shape (even-odd rule). */
export function insideShape(pts: readonly Pt[], p: Pt): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) hit = !hit;
  }
  return hit;
}

/**
 * Where a face's number goes: the middle of its area when that is inside it, else the middle of the
 * widest run across the shape at a few heights (a face with a notch, like an L or a dormer cut-out,
 * whose middle falls on another face).
 */
export function labelPoint(pts: readonly Pt[]): Pt {
  const average = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
  if (pts.length < 3) return average;
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]!;
    const b = pts[i]!;
    const cross = a.x * b.y - b.x * a.y;
    twice += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  const middle = Math.abs(twice) > 1e-9 ? { x: cx / (3 * twice), y: cy / (3 * twice) } : average;
  if (insideShape(pts, middle)) return middle;
  const ys = pts.map((p) => p.y);
  const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
  let best: { at: Pt; width: number } | null = null;
  for (const y of [middle.y, ...[0.2, 0.35, 0.5, 0.65, 0.8].map((k) => top + k * (bottom - top))]) {
    const xs: number[] = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!;
      const b = pts[j]!;
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const width = xs[k + 1]! - xs[k]!;
      if (!best || width > best.width) best = { at: { x: (xs[k]! + xs[k + 1]!) / 2, y }, width };
    }
  }
  return best?.at ?? middle;
}

export function mapShapes(r: RoofResult, excluded: readonly number[]): MapShapes {
  const zoom = mapZoom(r.box);
  const view = mapFrame(r.center, zoom);
  const out = new Set(excluded);
  const faces = r.faces.map((f) => ({ n: f.n, pts: f.poly.map(view.toPx), out: out.has(f.n) }));
  const shaped = new Set(r.faces.map((f) => f.n));
  const outline = r.outline.map((ring) => ring.map(view.toPx));
  const edges = r.edges.filter((e) => e.path.length >= 2 && EDGE_INFO[e.type]).map((e) => ({ type: e.type, pts: e.path.map(view.toPx) }));
  const labels = [
    ...faces.map((f) => ({ n: f.n, at: labelPoint(f.pts), out: f.out })),
    ...r.segments.filter((s) => !shaped.has(s.n) && s.center).map((s) => ({ n: s.n, at: view.toPx(s.center!), out: out.has(s.n) })),
  ];
  const half = MAP_SIZE / 2;
  const reach = Math.max(0, ...[...outline.flat(), ...faces.flatMap((f) => f.pts), ...edges.flatMap((e) => e.pts), ...labels.map((l) => l.at)].map((p) => Math.max(Math.abs(p.x - half), Math.abs(p.y - half))));
  const magnify = reach > 0 ? Math.max(1, Math.min(MAX_MAGNIFY, (FILL * half) / reach)) : 1;
  return { zoom, faces, outline, edges, labels, point: view.toPx(r.point), magnify };
}

/** SVG points attribute for a list of points. */
export const svgPoints = (pts: readonly Pt[]) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

/** Line widths in the 640 frame for a picture about 3 inches wide on paper. */
const PRINT = { edge: 5.6, edgeHalo: 10.4, outline: 4, outlineHalo: 8, hatch: 2, hatchGap: 11, label: 17, font: 19, ring: 3 };

/**
 * Paints the photo and the shapes onto a square canvas `size` pixels wide (the printed report).
 * Without a photo, a dark square stands in.
 */
export function paintRoofMap(g: CanvasRenderingContext2D, size: number, s: MapShapes, img: CanvasImageSource | null, opts: { edges?: boolean } = {}): void {
  const k = size / MAP_SIZE;
  g.save();
  g.setTransform(k, 0, 0, k, 0, 0);
  g.fillStyle = '#1e293b';
  g.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
  // Enlarged about the middle, like the photo on screen; lines and labels keep their size.
  const m = s.magnify;
  g.translate((MAP_SIZE / 2) * (1 - m), (MAP_SIZE / 2) * (1 - m));
  g.scale(m, m);
  if (img) g.drawImage(img, 0, 0, MAP_SIZE, MAP_SIZE);
  const path = (pts: readonly Pt[], close: boolean) => {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    if (close) g.closePath();
  };
  // Faces left out: shaded and hatched.
  for (const f of s.faces) {
    if (!f.out || f.pts.length < 3) continue;
    const xs = f.pts.map((p) => p.x);
    const ys = f.pts.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    g.save();
    path(f.pts, true);
    g.fillStyle = 'rgba(15,23,42,0.55)';
    g.fill();
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = PRINT.hatch / m;
    for (let x = x0 - (y1 - y0); x < x1; x += PRINT.hatchGap / m) {
      g.beginPath();
      g.moveTo(x, y1);
      g.lineTo(x + (y1 - y0), y0);
      g.stroke();
    }
    g.restore();
  }
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const ring of s.outline) {
    path(ring, true);
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = PRINT.outlineHalo / m;
    g.stroke();
    g.strokeStyle = OUTLINE_COLOR;
    g.lineWidth = PRINT.outline / m;
    g.stroke();
  }
  if (opts.edges !== false) {
    for (const e of s.edges) {
      const info = EDGE_INFO[e.type];
      path(e.pts, false);
      g.setLineDash([]);
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.lineWidth = PRINT.edgeHalo / m;
      g.stroke();
      g.setLineDash(info.dash ? info.dash.map((d) => (d * 1.6) / m) : []);
      g.strokeStyle = info.color;
      g.lineWidth = PRINT.edge / m;
      g.stroke();
    }
    g.setLineDash([]);
  }
  g.font = `700 ${PRINT.font / m}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const l of s.labels) {
    g.beginPath();
    g.arc(l.at.x, l.at.y, PRINT.label / m, 0, Math.PI * 2);
    g.fillStyle = l.out ? '#e2e8f0' : '#0f172a';
    g.fill();
    g.lineWidth = PRINT.ring / m;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.fillStyle = l.out ? '#475569' : '#ffffff';
    g.fillText(String(l.n), l.at.x, l.at.y + 1 / m);
  }
  g.restore();
}

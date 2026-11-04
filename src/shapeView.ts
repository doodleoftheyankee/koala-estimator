// Shape UI: the preset picker, the labelled preview drawing, the dimension inputs, and the
// tap-to-draw grid for custom polygons. One component serves both spaces and cutouts.

import { h, s, field } from './dom';
import { PRESET_DIMS, SHAPE_NAMES, signedArea, solveShape, type Point, type ShapeInput, type ShapeKind, type SolvedShape } from './geometry';
import { formatFeet, formatSqft, parseFeet } from './units';

const VIEW_W = 320;
const VIEW_H = 240;
const PAD = 40; // room for side labels

/** Little icons for the preset buttons (24×24 outlines). */
const ICONS: Record<ShapeKind, string> = {
  rect: 'M4 6h16v12H4z',
  L: 'M4 4h8v8h8v8H4z',
  T: 'M3 4h18v7h-6v9H9v-9H3z',
  U: 'M3 4h6v9h6V4h6v16H3z',
  custom: 'M4 18l3-12 7 3 6-4-2 15z',
};

/**
 * Draws a solved shape scaled to fit, with every side labelled: input sides as "A 24' 6"",
 * the rest with their computed length in grey.
 */
export function shapePreview(shape: SolvedShape | null, message?: string): SVGSVGElement {
  const svg = s('svg', { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, class: 'shape-preview', role: 'img' });
  if (!shape) {
    svg.append(s('text', { x: VIEW_W / 2, y: VIEW_H / 2, class: 'preview-empty', 'text-anchor': 'middle' }, message ?? 'Enter the sizes'));
    return svg;
  }
  const xs = shape.points.map((p) => p[0]);
  const ys = shape.points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((VIEW_W - 2 * PAD) / Math.max(maxX - minX, 1e-6), (VIEW_H - 2 * PAD) / Math.max(maxY - minY, 1e-6));
  const offX = (VIEW_W - (maxX - minX) * scale) / 2;
  const offY = (VIEW_H - (maxY - minY) * scale) / 2;
  // Feet → screen, flipping y so "up" in the plan is up on screen.
  const tx = (p: Point): Point => [offX + (p[0] - minX) * scale, VIEW_H - offY - (p[1] - minY) * scale];

  const d = shape.points.map((p, i) => `${i ? 'L' : 'M'}${tx(p).map((v) => v.toFixed(1)).join(' ')}`).join(' ') + 'Z';
  svg.append(s('path', { d, class: 'shape-fill' }));

  const ccw = signedArea(shape.points) > 0;
  // An unlettered side that just mirrors a lettered one (same length, parallel) adds clutter.
  const lettered = shape.edges.filter((e) => e.label && !e.label.startsWith('#'));
  const isEcho = (e: (typeof shape.edges)[number]) =>
    !e.label &&
    lettered.some((l) => {
      const cross = (e.to[0] - e.from[0]) * (l.to[1] - l.from[1]) - (e.to[1] - e.from[1]) * (l.to[0] - l.from[0]);
      return Math.abs(l.length - e.length) < 1e-6 && Math.abs(cross) < 1e-6 * Math.max(1, e.length * l.length);
    });
  // Place lettered labels first, then the grey ones. Each label tries spots along its own side,
  // stepping further out if needed, until it overlaps neither another label nor the outline.
  // (Text boxes are estimated: ~7.6px per character at 13px bold.)
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const placed: Box[] = [];
  const segments = shape.edges.map((e) => [tx(e.from), tx(e.to)] as const);
  const segHitsBox = ([a, b]: readonly [Point, Point], r: Box): boolean => {
    // Liang–Barsky clip of segment a→b against the box.
    let t0 = 0, t1 = 1;
    const ddx = b[0] - a[0], ddy = b[1] - a[1];
    const tests: Array<[number, number]> = [[-ddx, a[0] - r.x0], [ddx, r.x1 - a[0]], [-ddy, a[1] - r.y0], [ddy, r.y1 - a[1]]];
    for (const [pp, q] of tests) {
      if (pp === 0) {
        if (q < 0) return false;
      } else {
        const t = q / pp;
        if (pp < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
        if (t0 > t1) return false;
      }
    }
    return true;
  };
  const clear = (b: Box) =>
    !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0) && !segments.some((sg) => segHitsBox(sg, b));
  const order = [...shape.edges].sort((a, b) => Number(!a.label) - Number(!b.label));
  order.forEach((e) => {
    if (e.length < 1e-6 || isEcho(e)) return;
    const [x1, y1] = tx(e.from);
    const [x2, y2] = tx(e.to);
    // Outward normal on screen. Flipping y turns a counter-clockwise plan clockwise on screen,
    // where (−dy, dx) points outward; a clockwise sketch needs the opposite.
    const dx = x2 - x1, dy = y2 - y1;
    const sign = ccw ? 1 : -1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy * sign) / len, ny = (dx * sign) / len;
    const ux = dx / len, uy = dy / len;
    const text = e.label ? `${e.label} ${formatFeet(e.length)}` : formatFeet(e.length);
    // Labels on steep sides run along the side, like dimensions on a floor plan.
    const steep = Math.abs(dy) > Math.abs(dx);
    const w = text.length * 7.6, hgt = 15;
    const boxAt = (cx: number, cy: number): Box =>
      steep ? { x0: cx - hgt / 2, y0: cy - w / 2, x1: cx + hgt / 2, y1: cy + w / 2 } : { x0: cx - w / 2, y0: cy - hgt / 2, x1: cx + w / 2, y1: cy + hgt / 2 };
    const cx0 = (x1 + x2) / 2, cy0 = (y1 + y2) / 2;
    let mx = cx0 + nx * 16, my = cy0 + ny * 16;
    search: for (const off of [16, 28, 40]) {
      for (let t = 0; t <= len / 2 + w / 2; t += 4) {
        for (const tt of t ? [t, -t] : [0]) {
          const px = cx0 + nx * off + ux * tt, py = cy0 + ny * off + uy * tt;
          if (clear(boxAt(px, py))) {
            mx = px;
            my = py;
            break search;
          }
        }
      }
    }
    placed.push(boxAt(mx, my));
    const attrs: Record<string, string> = {
      x: mx.toFixed(1),
      y: my.toFixed(1),
      class: e.label ? 'edge-label' : 'edge-label muted',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    };
    if (steep) attrs.transform = `rotate(-90 ${mx.toFixed(1)} ${my.toFixed(1)})`;
    svg.append(s('text', attrs, text));
  });
  return svg;
}

/**
 * The full shape editor: preset picker, labelled preview, and the inputs. It redraws itself
 * and calls onChange after every edit so the caller can update totals and save.
 */
export function shapeEditor(shape: ShapeInput, onChange: () => void, opts: { compact?: boolean } = {}): HTMLElement {
  const root = h('div', { class: opts.compact ? 'shape-editor compact' : 'shape-editor' });

  const render = () => {
    const previewBox = h('div', { class: 'preview-box' });
    const areaLine = h('div', { class: 'shape-area' });
    const updatePreview = () => {
      const r = solveShape(shape);
      previewBox.replaceChildren(shapePreview(r.ok ? r.shape : null, r.ok ? undefined : shape.kind === 'custom' ? 'Draw the outline below' : 'Enter the sizes'));
      areaLine.textContent = r.ok ? `${formatSqft(r.shape.area)} sq ft · perimeter ${formatFeet(r.shape.perimeter)}` : '';
    };

    const picker = h(
      'div',
      { class: 'shape-picker', role: 'radiogroup', 'aria-label': 'Shape' },
      (Object.keys(SHAPE_NAMES) as ShapeKind[]).map((kind) =>
        h(
          'button',
          {
            type: 'button',
            class: kind === shape.kind ? 'chip selected' : 'chip',
            role: 'radio',
            'aria-checked': String(kind === shape.kind),
            onclick: () => {
              if (kind === shape.kind) return;
              shape.kind = kind;
              if (kind === 'custom') shape.custom ??= { points: [], closed: false, sides: [] };
              render();
              onChange();
            },
          },
          s('svg', { viewBox: '0 0 24 24', class: 'chip-icon', 'aria-hidden': 'true' }, s('path', { d: ICONS[kind] })),
          SHAPE_NAMES[kind],
        ),
      ),
    );

    let body: HTMLElement;
    if (shape.kind === 'custom') {
      body = customDrawer(shape, () => {
        updatePreview();
        onChange();
      });
    } else {
      body = h(
        'div',
        { class: 'dims' },
        PRESET_DIMS[shape.kind].map(({ key, label }) => {
          const f = field({
            label: `${key} · ${label}`,
            value: shape.dims[key] ?? '',
            placeholder: `e.g. 24'6"`,
            oninput: (v) => {
              shape.dims[key] = v;
              f.classList.toggle('invalid', v.trim() !== '' && parseFeet(v) === null);
              updatePreview();
              onChange();
            },
          });
          f.classList.toggle('invalid', (shape.dims[key] ?? '').trim() !== '' && parseFeet(shape.dims[key] ?? '') === null);
          return f;
        }),
      );
    }
    root.replaceChildren(picker, previewBox, areaLine, body);
    updatePreview();
  };

  render();
  return root;
}

const GRID_FT = 2; // one grid square = 2 ft
const GRID_N = 24; // 24 × 24 squares = a 48 ft sketch area
const CELL = 300 / GRID_N;

/**
 * Tap corners on a grid to sketch the outline, then type each side's real length. The sketch
 * only sets directions and proportions; blank sides fall back to their sketched length.
 */
function customDrawer(shape: ShapeInput, onChange: () => void): HTMLElement {
  const custom = (shape.custom ??= { points: [], closed: false, sides: [] });
  const root = h('div', { class: 'custom' });

  const render = () => {
    const svg = s('svg', { viewBox: '-6 -6 312 312', class: 'grid', 'aria-label': 'Drawing grid: tap corners in order' });
    for (let i = 0; i <= GRID_N; i++) {
      const p = i * CELL;
      const cls = i % 5 === 0 ? 'grid-line major' : 'grid-line';
      svg.append(s('line', { x1: p, y1: 0, x2: p, y2: 300, class: cls }), s('line', { x1: 0, y1: p, x2: 300, y2: p, class: cls }));
    }
    // Plan feet → screen (y up in the plan, down on screen).
    const toScreen = (p: Point): Point => [(p[0] / GRID_FT) * CELL, 300 - (p[1] / GRID_FT) * CELL];
    const pts = custom.points.map(toScreen);
    if (pts.length > 1) {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ') + (custom.closed ? 'Z' : '');
      svg.append(s('path', { d, class: custom.closed ? 'sketch closed' : 'sketch' }));
    }
    pts.forEach((p, i) => {
      svg.append(s('circle', { cx: p[0], cy: p[1], r: i === 0 ? 7 : 5, class: i === 0 ? 'corner first' : 'corner' }));
    });
    // Side numbers at each side's midpoint so the inputs below are easy to match.
    if (pts.length > 1) {
      const count = custom.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < count; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
        svg.append(
          s('circle', { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, r: 9, class: 'side-badge' }),
          s('text', { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, class: 'side-badge-text', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(i + 1)),
        );
      }
    }

    svg.addEventListener('pointerup', (ev) => {
      if (custom.closed) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
      const gx = Math.round(Math.min(Math.max(pt.x, 0), 300) / CELL);
      const gy = Math.round(Math.min(Math.max(pt.y, 0), 300) / CELL);
      const p: Point = [gx * GRID_FT, (GRID_N - gy) * GRID_FT];
      const first = custom.points[0];
      if (first && custom.points.length >= 3 && first[0] === p[0] && first[1] === p[1]) {
        close();
        return;
      }
      const last = custom.points.at(-1);
      if (last && last[0] === p[0] && last[1] === p[1]) return; // double tap on the same corner
      custom.points.push(p);
      render();
      onChange();
    });

    const close = () => {
      if (custom.points.length < 3) return;
      custom.closed = true;
      custom.sides = custom.points.map((_, i) => custom.sides[i] ?? '');
      render();
      onChange();
    };

    const tools = h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button', class: 'btn', disabled: custom.points.length === 0,
        onclick: () => {
          if (custom.closed) custom.closed = false;
          else custom.points.pop();
          custom.sides = custom.sides.slice(0, custom.points.length);
          render();
          onChange();
        },
      }, custom.closed ? 'Reopen' : 'Undo'),
      h('button', {
        type: 'button', class: 'btn', disabled: custom.points.length === 0,
        onclick: () => {
          if (!confirm('Clear the drawing and its side lengths?')) return;
          custom.points = [];
          custom.sides = [];
          custom.closed = false;
          render();
          onChange();
        },
      }, 'Clear'),
      h('button', { type: 'button', class: 'btn primary', disabled: custom.closed || custom.points.length < 3, onclick: close }, 'Close'),
    );

    const help = custom.closed
      ? 'Type each side\'s real length. Blank sides use the sketch.'
      : custom.points.length === 0
        ? `Tap the corners in order. One square = ${GRID_FT} ft; the sketch just sets the shape, your typed lengths set the size.`
        : 'Keep tapping corners. Tap the first (big) corner again to close.';

    const sides = custom.closed
      ? h(
          'div',
          { class: 'dims' },
          custom.points.map((p, i) => {
            const q = custom.points[(i + 1) % custom.points.length]!;
            const drawn = Math.hypot(q[0] - p[0], q[1] - p[1]);
            const f = field({
              label: `Side ${i + 1}`,
              value: custom.sides[i] ?? '',
              placeholder: `sketch: ${formatFeet(drawn)}`,
              oninput: (v) => {
                custom.sides[i] = v;
                f.classList.toggle('invalid', v.trim() !== '' && parseFeet(v) === null);
                onChange();
              },
            });
            return f;
          }),
        )
      : null;

    root.replaceChildren(h('p', { class: 'hint' }, help), svg, tools, sides ?? '');
  };

  render();
  return root;
}

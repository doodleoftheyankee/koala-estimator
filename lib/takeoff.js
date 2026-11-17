// Roof geometry for GET /api/takeoff (see CONTRACT.md). Pure functions, no I/O.
//
// A raster is { w, h, res, resY, minX, maxY, zone: { zone, south }, data }: a north-up UTM grid where pixel
// (u, v) covers x in [minX + u*res, minX + (u+1)*res) and y in (maxY - (v+1)*resY, maxY - v*resY].
// Continuous pixel coordinates follow the same rule, so pixel u has its center at u + 0.5.
// The mask and the surface heights (DSM) may come on different grids; every mapping between them goes
// through UTM meters.

const D2R = Math.PI / 180;
const WGS_A = 6378137, WGS_F = 1 / 298.257223563, K0 = 0.9996;
const E2 = WGS_F * (2 - WGS_F), EP2 = E2 / (1 - E2);

export const EDGE_TYPES = ['ridge', 'hip', 'valley', 'eave', 'rake', 'step', 'headwall', 'break'];
export const FT = 0.3048;

// Tuning, in meters unless noted.
const FIT_WINDOW = 0.3;          // a face's plane height is the densest band this thick over its Solar box...
const FIT_MIN = 10;              // ...when the box holds at least this many roof pixels
const FIT_RADIUS = 1.0;          // otherwise the surface heights within this distance of the face center
const CUT_GROW = 0.5;            // the outline keeps the rooftop mask this far past Google's building box
const MIN_HOLE = 4;              // m2: smaller holes in the mask are filled; bigger ones are courtyards
const BOX_GROW = 1.0;            // a face can claim roof pixels this far outside Google's box for it
const FIT_TOL = 0.3;             // a pixel belongs to the best-fitting face if it is this close to its plane...
const STEP_JUMP = 0.4;           // height jump that makes an edge a step (wall or higher roof)
const MIN_EDGE = 0.5;            // shorter edges are dropped
const LEVEL_SLOPE = Math.tan(10 * D2R); // an edge flatter than this is level (ridge, eave)
const RAKE_DOT = Math.sin(45 * D2R);    // an outer side this close to the fall line is a rake
const FLAT_SLOPE = 0.02;         // faces flatter than this have no meaningful downhill direction
const TRIM = 0.02;               // tails trimmed off boundary points before measuring an inside edge

const r7 = v => Math.round(v * 1e7) / 1e7;
const r3 = v => Math.round(v * 1e3) / 1e3;
const r2 = v => Math.round(v * 1e2) / 1e2;
const r1 = v => Math.round(v * 10) / 10;

/* ---------------- UTM ---------------- */

export function utmZoneOf(keys) {
  const c = keys && keys.ProjectedCSTypeGeoKey;
  if (c >= 32601 && c <= 32660) return { zone: c - 32600, south: false };
  if (c >= 32701 && c <= 32760) return { zone: c - 32700, south: true };
  if (c >= 26901 && c <= 26923) return { zone: c - 26900, south: false };
  return null;
}

export function zoneOfLatLng(lat, lng) {
  return { zone: Math.min(60, Math.max(1, Math.floor((lng + 180) / 6) + 1)), south: lat < 0 };
}

const lam0Of = z => ((z.zone - 1) * 6 - 180 + 3) * D2R;

// Lat/lng (WGS84 degrees) to UTM meters. Same series as the page (Snyder, USGS PP 1395).
export function utm(lat, lng, z) {
  const phi = lat * D2R, lam = lng * D2R, lam0 = lam0Of(z);
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = WGS_A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, A = c * (lam - lam0);
  const M = WGS_A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));
  return {
    x: K0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * A ** 5 / 120) + 500000,
    y: K0 * (M + N * t * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * A ** 6 / 720)) + (z.south ? 1e7 : 0),
  };
}

// UTM meters to lat/lng. Snyder's footpoint-latitude series, then one Newton step against utm() above so a
// round trip through both is exact to well under a millimeter anywhere in the zone.
export function utmInverse(x, y, z) {
  const xx = x - 500000, yy = z.south ? y - 1e7 : y;
  const M = yy / K0;
  const mu = M / (WGS_A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const se = Math.sqrt(1 - E2), e1 = (1 - se) / (1 + se);
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s1 = Math.sin(phi1), c1 = Math.cos(phi1), t1 = Math.tan(phi1);
  const C1 = EP2 * c1 * c1, T1 = t1 * t1, w = 1 - E2 * s1 * s1;
  const N1 = WGS_A / Math.sqrt(w), R1 = WGS_A * (1 - E2) / (w * Math.sqrt(w)), D = xx / (N1 * K0);
  const phi = phi1 - (N1 * t1 / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lam = lam0Of(z) + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c1;
  let lat = phi / D2R, lng = lam / D2R;
  // Newton refinement: the series is already good to millimeters; this makes it the exact inverse of utm().
  const p = utm(lat, lng, z), d = 1e-6, a = utm(lat + d, lng, z), b = utm(lat, lng + d, z);
  const j11 = (b.x - p.x) / d, j12 = (a.x - p.x) / d, j21 = (b.y - p.y) / d, j22 = (a.y - p.y) / d, det = j11 * j22 - j12 * j21;
  const ex = x - p.x, ey = y - p.y;
  lng += (j22 * ex - j12 * ey) / det;
  lat += (j11 * ey - j21 * ex) / det;
  return { lat, lng };
}

// Pixel <-> UTM for one raster (continuous pixel coordinates, see the top of this file).
export const pxOf = (r, x, y) => [(x - r.minX) / r.res, (r.maxY - y) / r.resY];
export const utmOfPx = (r, u, v) => [r.minX + u * r.res, r.maxY - v * r.resY];

// Pixel <-> lat/lng for one raster.
export function latLngFrame(r) {
  return {
    toPx: (lat, lng) => { const p = utm(lat, lng, r.zone); return pxOf(r, p.x, p.y); },
    toLatLng: (u, v) => { const [x, y] = utmOfPx(r, u, v); return utmInverse(x, y, r.zone); },
  };
}

/* ---------------- outline tracing (ported from index.html) ---------------- */

const DX8 = [-1, -1, 0, 1, 1, 1, 0, -1], DY8 = [0, -1, -1, -1, 0, 1, 1, 1];

// Walk the edge of one blob (Moore neighbor tracing), starting at its top-left pixel.
export function traceEdge(inC, sx, sy, limit) {
  const pts = [[sx, sy]];
  let cx = sx, cy = sy, b = 0;
  for (let step = 0; step < limit; step++) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (b + k) % 8, nx = cx + DX8[d], ny = cy + DY8[d];
      if (!inC(nx, ny)) continue;
      const pd = (b + k + 7) % 8, ddx = cx + DX8[pd] - nx, ddy = cy + DY8[pd] - ny;
      b = DX8.findIndex((v, i) => v === ddx && DY8[i] === ddy);
      cx = nx; cy = ny; moved = true; break;
    }
    if (!moved || (cx === sx && cy === sy)) break;
    pts.push([cx, cy]);
  }
  return pts;
}

export function dpOpen(pts, tol) {
  return dpOpenIdx(pts, tol).map(i => pts[i]);
}
function dpOpenIdx(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.map((_, i) => i);
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const st = [[0, n - 1]];
  while (st.length) {
    const [s, e] = st.pop(), [x1, y1] = pts[s], [x2, y2] = pts[e], L = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const dd = Math.abs((x2 - x1) * (y1 - pts[i][1]) - (x1 - pts[i][0]) * (y2 - y1)) / L;
      if (dd > md) { md = dd; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// Splits the ring at its two most distant points (true corners, unlike the tracing's start pixel, which on a
// tilted edge can sit a few pixels short of the corner) and simplifies each half.
export function simplifyClosed(pts, tol) {
  return simplifyClosedIdx(pts, tol).map(i => pts[i]);
}
function simplifyClosedIdx(pts, tol) {
  const n = pts.length;
  if (n < 8) return pts.map((_, i) => i);
  const farFrom = i0 => {
    let far = i0, best = -1;
    for (let i = 0; i < n; i++) { const d = (pts[i][0] - pts[i0][0]) ** 2 + (pts[i][1] - pts[i0][1]) ** 2; if (d > best) { best = d; far = i; } }
    return far;
  };
  const p = farFrom(0), q = farFrom(p);
  const i0 = Math.min(p, q), i1 = Math.max(p, q);
  if (i0 === i1) return pts.map((_, i) => i);
  const a = dpOpenIdx(pts.slice(i0, i1 + 1), tol).map(i => i + i0);
  const b = dpOpenIdx(pts.slice(i1).concat(pts.slice(0, i0 + 1)), tol).map(i => (i + i1) % n);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

// Simplifies a traced ring, then puts each corner where the straight runs of pixels on either side of it meet
// (a least-squares line through each run), instead of on whichever stair-step pixel the simplification kept.
export function straightenClosed(pts, tol) {
  const idx = simplifyClosedIdx(pts, tol), m = idx.length, n = pts.length;
  if (m < 3) return idx.map(i => pts[i]);
  const lines = idx.map((i, k) => {
    const j = idx[(k + 1) % m], run = [];
    for (let q = i; ; q = (q + 1) % n) { run.push(pts[q]); if (q === j) break; }
    const cut = run.length > 10 ? 2 : 0, r = run.slice(cut, run.length - cut);
    if (r.length < Math.max(8, 3 * tol)) return null; // too short to trust its direction
    let mx = 0, my = 0;
    for (const [x, y] of r) { mx += x; my += y; }
    mx /= r.length; my /= r.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of r) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { mx, my, tx: Math.cos(ang), ty: Math.sin(ang) };
  });
  return idx.map((i, k) => {
    const a = lines[(k - 1 + m) % m], b = lines[k], v = pts[i];
    if (!a || !b) return v;
    const den = a.tx * b.ty - a.ty * b.tx;
    if (Math.abs(den) < Math.sin(20 * D2R)) return v;
    const t = ((b.mx - a.mx) * b.ty - (b.my - a.my) * b.tx) / den;
    const x = a.mx + a.tx * t, y = a.my + a.ty * t;
    return Math.hypot(x - v[0], y - v[1]) <= Math.max(1.5, 1.5 * tol) ? [x, y] : v;
  });
}

// The traced line runs through pixel centers; push it out half a pixel so edges measure to the true roof edge.
export function offsetPoly(p, dist0) {
  const n = p.length;
  let A = 0;
  for (let i = 0; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; A += a[0] * b[1] - b[0] * a[1]; }
  const sgn = A > 0 ? 1 : -1;
  const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [sgn * dy / L, -sgn * dx / L]; };
  return p.map((v, i) => {
    const n1 = nrm(p[(i - 1 + n) % n], v), n2 = nrm(v, p[(i + 1) % n]);
    const bx = n1[0] + n2[0], by = n1[1] + n2[1], bl = Math.hypot(bx, by);
    if (bl < 1e-6) return [v[0] + n1[0] * dist0, v[1] + n1[1] * dist0];
    const m = dist0 / Math.max((n1[0] * bx + n1[1] * by) / bl, 0.25);
    return [v[0] + bx / bl * m, v[1] + by / bl * m];
  });
}

// Pick the blobs of the rooftop mask that hold this building's faces (8-connected) and outline each one.
// Falls back to the blob nearest the building center.
// opts.clip { u0, u1, v0, v1 } (inclusive pixel ranges): pixels of the chosen blobs outside it are cut off (a
// neighbour's roof joined to this one); cutX and cutY count the pixel sides along that cut (left/right and
// up/down neighbours). opts.minHole (pixels): smaller holes are filled; bigger ones (courtyards) are outlined too.
// Returns the outlines in mask pixels (outer rings first, then holes), the pixel count, isSel(i) and isCut(i)
// for every mask pixel index.
export function roofOutline(mask, w, h, seeds, center, nearPx, tol, opts = {}) {
  const lab = new Int32Array(w * h), comps = [], on = i => mask[i] > 0;
  const fill = start => {
    const sx = start % w, sy = (start - sx) / w;
    const c = { id: comps.length + 1, n: 0, top: start, hits: 0, x0: sx, x1: sx, y0: sy, y1: sy }; comps.push(c);
    const st = [start]; lab[start] = c.id;
    while (st.length) {
      const i = st.pop(), x = i % w, y = (i - x) / w;
      c.n++; if (i < c.top) c.top = i;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!lab[k] && on(k)) { lab[k] = c.id; st.push(k); }
      }
    }
    return c;
  };
  const compAt = i => (lab[i] ? comps[lab[i] - 1] : fill(i));
  const seedPx = [];
  for (const s of seeds) {
    const x = Math.floor(s.x), y = Math.floor(s.y);
    if (x >= 0 && y >= 0 && x < w && y < h && on(y * w + x)) { compAt(y * w + x).hits++; seedPx.push(y * w + x); }
  }
  let chosen = comps.filter(c => c.hits);
  if (!chosen.length) {
    let best = -1, bd = Infinity;
    const cx = Math.floor(center.x), cy = Math.floor(center.y);
    for (let y = Math.max(0, cy - nearPx); y <= Math.min(h - 1, cy + nearPx); y++) {
      for (let x = Math.max(0, cx - nearPx); x <= Math.min(w - 1, cx + nearPx); x++) {
        const i = y * w + x;
        if (on(i)) { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < bd) { bd = d; best = i; } }
      }
    }
    if (best >= 0) chosen = [compAt(best)];
  }
  const sel = new Uint8Array(w * h), cut = new Uint8Array(w * h);
  const empty = { polys: [], count: 0, isSel: () => false, isCut: () => false, cutX: 0, cutY: 0, holes: 0 };
  if (!chosen.length) return empty;
  const flag = new Uint8Array(comps.length + 1);
  for (const c of chosen) flag[c.id] = 1;
  const X0 = Math.min(...chosen.map(c => c.x0)), X1 = Math.max(...chosen.map(c => c.x1));
  const Y0 = Math.min(...chosen.map(c => c.y0)), Y1 = Math.max(...chosen.map(c => c.y1));
  const clipOf = c => (c ? (x, y) => x >= c.u0 && x <= c.u1 && y >= c.v0 && y <= c.v1 : () => true);
  let inClip = clipOf(opts.clip), kept = 0;
  const select = () => {
    kept = 0;
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0; x <= X1; x++) {
        const i = y * w + x;
        sel[i] = 0; cut[i] = 0;
        if (flag[lab[i]] !== 1) continue;
        if (inClip(x, y)) { sel[i] = 1; kept++; } else cut[i] = 1;
      }
    }
  };
  select();
  if (!kept) { inClip = clipOf(null); select(); } // the box missed the roof entirely: keep the whole blob

  // A cut can leave scraps of the neighbour's roof inside the box: keep the pieces that hold a face center
  // (or the biggest piece), as before the cut.
  const bw = X1 - X0 + 1, bh = Y1 - Y0 + 1, piece = new Int32Array(bw * bh), pieces = [];
  const stack = new Int32Array(bw * bh);
  for (let y = Y0; y <= Y1; y++) {
    for (let x = X0; x <= X1; x++) {
      const i = y * w + x, j = (y - Y0) * bw + (x - X0);
      if (!sel[i] || piece[j]) continue;
      const pc = { id: pieces.length + 1, n: 0, top: i, hits: 0 }; pieces.push(pc);
      let sp = 0; stack[sp++] = j; piece[j] = pc.id;
      while (sp) {
        const q = stack[--sp], qx = q % bw, qy = (q - qx) / bw, gi = (qy + Y0) * w + qx + X0;
        pc.n++; if (gi < pc.top) pc.top = gi;
        for (let d = 0; d < 8; d++) {
          const nx = qx + DX8[d], ny = qy + DY8[d];
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const k = ny * bw + nx;
          if (!piece[k] && sel[(ny + Y0) * w + nx + X0]) { piece[k] = pc.id; stack[sp++] = k; }
        }
      }
    }
  }
  for (const i of seedPx) {
    const x = i % w, y = (i - x) / w;
    if (sel[i]) pieces[piece[(y - Y0) * bw + (x - X0)] - 1].hits++;
  }
  let keep = pieces.filter(p => p.hits);
  if (!keep.length) keep = [pieces.reduce((a, b) => (b.n > a.n ? b : a))];
  const keepFlag = new Uint8Array(pieces.length + 1);
  for (const p of keep) keepFlag[p.id] = 1;
  let count = 0, cutX = 0, cutY = 0;
  for (let y = Y0; y <= Y1; y++) {
    for (let x = X0; x <= X1; x++) {
      const i = y * w + x;
      if (!sel[i]) continue;
      if (!keepFlag[piece[(y - Y0) * bw + (x - X0)]]) { sel[i] = 0; continue; }
      count++;
      if (x > 0 && cut[i - 1]) cutX++;
      if (x < w - 1 && cut[i + 1]) cutX++;
      if (y > 0 && cut[i - w]) cutY++;
      if (y < h - 1 && cut[i + w]) cutY++;
    }
  }

  // Holes: background inside the kept pixels' box that doesn't reach the box's edge (4-connected).
  let hx0 = Infinity, hx1 = -1, hy0 = Infinity, hy1 = -1;
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (sel[y * w + x]) { if (x < hx0) hx0 = x; if (x > hx1) hx1 = x; if (y < hy0) hy0 = y; if (y > hy1) hy1 = y; }
  const holes = [];
  const hw = hx1 - hx0 + 1, hh = hy1 - hy0 + 1, hole = new Int32Array(Math.max(0, hw * hh));
  const minHole = opts.minHole || 0;
  let hid = 0;
  for (let y = hy0; y <= hy1; y++) {
    for (let x = hx0; x <= hx1; x++) {
      const j0 = (y - hy0) * hw + (x - hx0);
      if (sel[y * w + x] || hole[j0]) continue;
      hid++;
      const members = [];
      let sp = 0, open = false, top = y * w + x;
      stack[sp++] = j0; hole[j0] = hid;
      while (sp) {
        const q = stack[--sp], qx = q % hw, qy = (q - qx) / hw;
        members.push(q);
        if (qx === 0 || qy === 0 || qx === hw - 1 || qy === hh - 1) open = true;
        const gi = (qy + hy0) * w + qx + hx0;
        if (gi < top) top = gi;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= hw || ny >= hh) continue;
          const k = ny * hw + nx;
          if (!hole[k] && !sel[(ny + hy0) * w + nx + hx0]) { hole[k] = hid; stack[sp++] = k; }
        }
      }
      if (open) continue;
      if (members.length < minHole) {
        for (const q of members) { const qx = q % hw, qy = (q - qx) / hw; sel[(qy + hy0) * w + qx + hx0] = 1; count++; }
      } else holes.push({ id: hid, top });
    }
  }

  const ring = (inC, top) => {
    const tx = top % w, r = traceEdge(inC, tx, (top - tx) / w, w * h).map(([x, y]) => [x + 0.5, y + 0.5]);
    return offsetPoly(simplifyClosed(r, tol), 0.5);
  };
  const outer = keep.map(p => ring((x, y) => x >= X0 && y >= Y0 && x <= X1 && y <= Y1 && sel[y * w + x] === 1 && piece[(y - Y0) * bw + (x - X0)] === p.id, p.top));
  const inner = holes.map(q => ring((x, y) => x >= hx0 && y >= hy0 && x <= hx1 && y <= hy1 && hole[(y - hy0) * hw + (x - hx0)] === q.id, q.top));
  const polys = outer.filter(p => p.length >= 3), holePolys = inner.filter(p => p.length >= 3);
  return {
    polys: polys.concat(holePolys), count, isSel: i => sel[i] === 1, isCut: i => cut[i] === 1,
    cutX, cutY, holes: holePolys.length,
  };
}

/* ---------------- small helpers ---------------- */

function median(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort(), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Median of the values inside the densest window of the given width (the mode of a noisy set).
function densestMedian(vals, width) {
  const s = Float64Array.from(vals).sort();
  let best = 0, bi = 0, bj = 0;
  for (let i = 0, j = 0; i < s.length; i++) {
    while (j < s.length && s[j] - s[i] <= width) j++;
    if (j - i > best) { best = j - i; bi = i; bj = j; }
  }
  return median(s.subarray(bi, bj));
}

const ringLength = (poly, sx, sy) => poly.reduce((s, q, i) => {
  const nx = poly[(i + 1) % poly.length];
  return s + Math.hypot((nx[0] - q[0]) * sx, (nx[1] - q[1]) * sy);
}, 0);

const signedArea = poly => {
  let A = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; A += a[0] * b[1] - b[0] * a[1]; }
  return A / 2;
};

export function emptyTotals() {
  return Object.fromEntries(EDGE_TYPES.map(t => [t, 0]));
}

export const riseOf = pitchDeg => r1(12 * Math.tan(pitchDeg * D2R));

// Size of the measuring photo to ask Google for, as the page's loadOrtho does, but never so big that the
// browser can't download the color photo through /api/geotiff (Vercel's 4.5 MB response limit).
export const PIXEL_STEPS = [0.1, 0.25, 0.5, 1];
export function layerSize(building, center) {
  const b = building || {};
  const c = center || b.center;
  let half = 12;
  if (b.box && c) {
    const wM = Math.abs(b.box.ne.lng - b.box.sw.lng) * 111320 * Math.cos(c.lat * D2R), hM = Math.abs(b.box.ne.lat - b.box.sw.lat) * 111320;
    half = Math.max(wM, hM) / 2;
  }
  const radius = Math.round(Math.max(12, Math.min(60, half * 1.3 + 3)));
  let pixel = b.quality === 'HIGH' && radius <= 40 ? 0.1 : (b.quality === 'HIGH' || b.quality === 'MEDIUM') ? 0.25 : 0.5;
  while ((2 * radius / pixel) ** 2 * 3 > 4e6 && pixel < 1) pixel = PIXEL_STEPS[PIXEL_STEPS.indexOf(pixel) + 1];
  return { radius, pixel };
}

/* ---------------- attic floor (CONTRACT.md "Attic floor") ---------------- */

// Perimeter of a rectangle with area A and the box's aspect ratio.
function boxPerimeter(box, A) {
  const lat = (box.sw.lat + box.ne.lat) / 2;
  const wM = Math.abs(box.ne.lng - box.sw.lng) * 111320 * Math.cos(lat * D2R), hM = Math.abs(box.ne.lat - box.sw.lat) * 111320;
  const r = wM > 0 && hM > 0 ? wM / hM : 1;
  return 2 * (Math.sqrt(A * r) + Math.sqrt(A / r));
}

/**
 * CONTRACT.md "Default face choices (v1.1)". heightOf(n) is each face's plane height at its center, all in one
 * datum (NaN when unknown). Returns { excluded: [n], lower: Set of n, mostlyFlat }.
 */
export function faceDefaults(segments, heightOf) {
  const segs = segments || [];
  const steep = segs.filter(s => !s.lowSlope), total = segs.reduce((t, s) => t + (s.groundM2 || 0), 0);
  const steepGround = steep.reduce((t, s) => t + (s.groundM2 || 0), 0);
  if (segs.length && steepGround < total / 2) return { excluded: [], lower: lowerOf(segs, heightOf, steep), mostlyFlat: true };
  const mainH = mainHeight(steep, heightOf);
  const excluded = segs.filter(s => s.lowSlope && (!Number.isFinite(mainH) || !Number.isFinite(heightOf(s.n)) || heightOf(s.n) < mainH - 1)).map(s => s.n);
  return { excluded, lower: lowerOf(segs, heightOf, steep), mostlyFlat: false };
}
// Ground-area-weighted median plane height of the steep faces.
function mainHeight(steep, heightOf) {
  const hs = steep.filter(s => Number.isFinite(heightOf(s.n))).map(s => ({ h: heightOf(s.n), g: s.groundM2 || 0 })).sort((a, b) => a.h - b.h);
  const half = hs.reduce((t, x) => t + x.g, 0) / 2;
  let run = 0;
  for (const x of hs) { run += x.g; if (run >= half) return x.h; }
  return NaN;
}
function lowerOf(segs, heightOf, steep) {
  const mainH = mainHeight(steep, heightOf), out = new Set();
  if (Number.isFinite(mainH)) for (const s of segs) if (heightOf(s.n) < mainH - 1.5) out.add(s.n);
  return out;
}

// Faces bigger than 3 m2 that got no traced shape, or one under half their Solar ground area (a tree over them,
// a dormer Google didn't report): their edges are missing or short.
export function untracedFaces(segments, faces) {
  const traced = new Map((faces || []).map(f => [f.n, f.planM2]));
  return (segments || []).filter(s => s.groundM2 > 3 && !(traced.get(s.n) >= 0.5 * s.groundM2)).map(s => s.n);
}

// Each face's plane height in one datum: the surface heights (DSM) where a face was fitted to them, else
// Google's planeHeightAtCenterMeters moved onto the DSM's datum by the faces that have both.
export function planeHeightOf(segments, fitted) {
  const f = fitted || {}, has = n => Number.isFinite(f[n]);
  const both = (segments || []).filter(s => has(s.n) && Number.isFinite(s.heightM));
  const off = both.length ? median(both.map(s => f[s.n] - s.heightM)) : (Object.keys(f).length ? NaN : 0);
  const byN = new Map((segments || []).map(s => [s.n, s]));
  return n => {
    if (has(n)) return f[n];
    const s = byN.get(n);
    return s && Number.isFinite(s.heightM) ? s.heightM + off : NaN;
  };
}

/**
 * CONTRACT.md "Attic floor". excluded: face numbers left out (default: every low-slope face, as in v1).
 * sharedWallM: outline length cut along a neighbour's roof. perimeterByFaceM: { n: m } of each face's sides on
 * the outline.
 */
export function atticFloor({ building, segments, outline, overhangM, sharedWallM = 0, excluded, perimeterByFaceM }) {
  const b = building || {}, segs = segments || [];
  const d = overhangM;
  let A = 0;
  if (outline && outline.areaM2 > 0) A = outline.areaM2;
  else if (b.whole && b.whole.groundM2 > 0) A = b.whole.groundM2;
  else if (b.faces && b.faces.groundM2 > 0) A = b.faces.groundM2;
  let P = 0, perimeterSource = 'none';
  if (outline && outline.perimeterM > 0) { P = outline.perimeterM; perimeterSource = 'outline'; }
  else if (b.box) { P = r3(boxPerimeter(b.box, A)); perimeterSource = 'box'; }
  const S = perimeterSource === 'outline' ? Math.min(Math.max(0, sharedWallM || 0), P) : 0;
  const byFace = perimeterSource === 'outline' && perimeterByFaceM ? perimeterByFaceM : {};
  const outN = new Set(excluded ? excluded : segs.filter(s => s.lowSlope).map(s => s.n));
  const out = segs.filter(s => outN.has(s.n)), kept = segs.filter(s => !outN.has(s.n));
  const excludedM2 = r2(out.reduce((t, x) => t + (x.groundM2 || 0), 0));
  const unmatchedM2 = r2(Math.max(0, A - segs.reduce((t, x) => t + (x.groundM2 || 0), 0)));
  const floorAll = Math.max(0, A - (P - S) * d + 4 * d * d);
  const floor = A > 0 ? floorAll * Math.max(0, 1 - excludedM2 / A) : 0;
  const excludedPerimM = out.reduce((t, x) => t + (byFace[String(x.n)] || 0), 0);
  const keptGround = kept.reduce((t, x) => t + (x.groundM2 || 0), 0), keptArea = kept.reduce((t, x) => t + (x.areaM2 || 0), 0);
  return {
    overhangM: d, footprintM2: A, perimeterM: P, perimeterSource,
    sharedWallM: r3(S), unmatchedM2, perimeterByFaceM: { ...byFace },
    excluded: out.map(s => s.n), excludedM2,
    floorM2: r2(floor), wallRunM: r3(Math.max(0, P - S - excludedPerimM - 8 * d)),
    deckM2: kept.length && keptGround > 0 ? r2(r2(floor) * keptArea / keptGround) : null,
  };
}

/* ---------------- faces, edges ---------------- */

// Each Solar face as a plane in UTM: height = z0 - m * ((p - c) . d), d = downhill unit vector.
function facePlanes(segments, zone) {
  const out = [];
  for (const s of segments) {
    if (!s.center || !Number.isFinite(s.pitchDeg) || !Number.isFinite(s.azimuthDeg)) continue;
    const c = utm(s.center.lat, s.center.lng, zone);
    // Grid north and east at the face (UTM grid north is a fraction of a degree off true north).
    const n = utm(s.center.lat + 1e-5, s.center.lng, zone), e = utm(s.center.lat, s.center.lng + 1e-5, zone);
    const nL = Math.hypot(n.x - c.x, n.y - c.y), eL = Math.hypot(e.x - c.x, e.y - c.y);
    const az = s.azimuthDeg * D2R, sa = Math.sin(az), ca = Math.cos(az);
    let dx = sa * (e.x - c.x) / eL + ca * (n.x - c.x) / nL, dy = sa * (e.y - c.y) / eL + ca * (n.y - c.y) / nL;
    const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    let x0, x1, y0, y1;
    if (s.box) {
      const pts = [[s.box.sw.lat, s.box.sw.lng], [s.box.sw.lat, s.box.ne.lng], [s.box.ne.lat, s.box.sw.lng], [s.box.ne.lat, s.box.ne.lng]]
        .map(([la, ln]) => utm(la, ln, zone));
      x0 = Math.min(...pts.map(p => p.x)); x1 = Math.max(...pts.map(p => p.x));
      y0 = Math.min(...pts.map(p => p.y)); y1 = Math.max(...pts.map(p => p.y));
    } else {
      const r = Math.max(1, Math.sqrt(s.groundM2 || 1));
      x0 = c.x - r; x1 = c.x + r; y0 = c.y - r; y1 = c.y + r;
    }
    out.push({
      n: s.n, cx: c.x, cy: c.y, dx, dy, m: Math.tan(Math.max(0, s.pitchDeg) * D2R), heightM: s.heightM, z0: NaN, fitted: false,
      bx0: x0, bx1: x1, by0: y0, by1: y1,
      x0: x0 - BOX_GROW, x1: x1 + BOX_GROW, y0: y0 - BOX_GROW, y1: y1 + BOX_GROW,
    });
  }
  return out;
}

const planeAt = (f, x, y) => f.z0 - f.m * ((x - f.cx) * f.dx + (y - f.cy) * f.dy);

// 3x3 majority (mode) filter over roof pixels; label 0 (no face fits) takes part like any other label.
function majorityFilter(lab, roof, w, h, passes) {
  let cur = lab, next = new Uint16Array(lab.length);
  const vals = new Int32Array(9), cnts = new Int32Array(9);
  for (let p = 0; p < passes; p++) {
    next.set(cur);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!roof[i]) continue;
        const c = cur[i];
        let uniform = true;
        for (let dy = -1; dy <= 1 && uniform; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = i + dy * w + dx;
            if (roof[j] && cur[j] !== c) { uniform = false; break; }
          }
        }
        if (uniform) continue;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = i + dy * w + dx;
            if (!roof[j]) continue;
            const l = cur[j];
            let q = 0;
            while (q < k && vals[q] !== l) q++;
            if (q === k) { vals[k] = l; cnts[k] = 0; k++; }
            cnts[q]++;
          }
        }
        let best = c, bc = 0, cc = 0;
        for (let q = 0; q < k; q++) {
          if (vals[q] === c) cc = cnts[q];
          if (cnts[q] > bc) { bc = cnts[q]; best = vals[q]; }
        }
        if (bc > cc) next[i] = best;
      }
    }
    const t = cur; cur = next; next = t;
  }
  return cur;
}

// Largest 8-connected blob of each label. Returns per label { size, top } and the blob id image.
function largestBlobs(lab, w, h, nLabels) {
  const comp = new Int32Array(w * h), best = Array.from({ length: nLabels + 1 }, () => null);
  let id = 0;
  const st = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    const l = lab[start];
    if (!l || comp[start]) continue;
    id++;
    let sp = 0, size = 0, top = start;
    st[sp++] = start; comp[start] = id;
    while (sp) {
      const i = st[--sp], x = i % w, y = (i - x) / w;
      size++; if (i < top) top = i;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!comp[k] && lab[k] === l) { comp[k] = id; st[sp++] = k; }
      }
    }
    if (!best[l] || size > best[l].size) best[l] = { id, size, top };
  }
  return { comp, best };
}

// The line two faces meet along. pts: flat [x0, y0, x1, y1, ...] UTM boundary points between face a and face b.
// Returns the line (a point on it and its direction) and the runs of points along it: separate stretches of
// one line, such as a main ridge broken by a dormer that ties in at the ridge, are split where the points stop
// for more than `gap` meters.
function lineOfPair({ fa, fb, pts, gap }) {
  const n = pts.length / 2;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += pts[2 * i]; my += pts[2 * i + 1]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const ex = pts[2 * i] - mx, ey = pts[2 * i + 1] - my; sxx += ex * ex; syy += ey * ey; sxy += ex * ey; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const pcaT = [Math.cos(ang), Math.sin(ang)];
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-12, tr / 2 - disc);
  // Direction: where the two planes meet (horizontal part of n_a x n_b), unless the planes are nearly
  // parallel or the boundary clearly runs another way.
  const gax = fa.m * fa.dx, gay = fa.m * fa.dy, gbx = fb.m * fb.dx, gby = fb.m * fb.dy;
  const ddx = gax - gbx, ddy = gay - gby, dl = Math.hypot(ddx, ddy);
  let t = pcaT;
  if (dl > 0.05) {
    const pt = [ddy / dl, -ddx / dl];
    const agree = Math.abs(pt[0] * pcaT[0] + pt[1] * pcaT[1]);
    if (!(l1 / l2 > 10 && agree < Math.cos(25 * D2R))) t = pt;
  }
  const proj = new Float64Array(n);
  for (let i = 0; i < n; i++) proj[i] = (pts[2 * i] - mx) * t[0] + (pts[2 * i + 1] - my) * t[1];
  proj.sort();
  const runs = [];
  for (let a = 0, b = 1; b <= n; b++) {
    if (b < n && proj[b] - proj[b - 1] <= gap) continue;
    const r = proj.subarray(a, b), m = r.length;
    const q = f => { const k = f * (m - 1), i = Math.floor(k), j = Math.min(m - 1, i + 1); return r[i] + (r[j] - r[i]) * (k - i); };
    runs.push({ lo: q(TRIM), hi: q(1 - TRIM), n: m });
    a = b;
  }
  return { mx, my, t, runs };
}

/**
 * Measures the roof from the rooftop mask and the surface heights.
 * segments: trimmed Solar faces (n, pitchDeg, azimuthDeg, center, box, heightM, groundM2).
 * center: building center { lat, lng } (falls back to the blob nearest it).
 * box: Google's building box { sw, ne }; the outline is cut 0.5 m past it (twins and rowhouses).
 * mask, dsm: rasters (either may be null).
 * Returns { outline, faces, edges, edgeTotalsM, sharedWallM, perimeterByFaceM, planeHeights }:
 * sharedWallM is the outline length along the cut, perimeterByFaceM { n: m } the plan length of each face's sides
 * on the outline, planeHeights { n: m } each face's plane height at its center fitted to the surface heights.
 */
export function measureRoof({ segments, center, box, mask, dsm }) {
  const result = { outline: null, faces: [], edges: [], edgeTotalsM: emptyTotals(), sharedWallM: 0, perimeterByFaceM: {}, planeHeights: {} };
  if (!mask || !mask.zone) return result;
  const zone = mask.zone;
  const toLL = (x, y) => { const p = utmInverse(x, y, zone); return { lat: r7(p.lat), lng: r7(p.lng) }; };

  /* outline from the mask, cut at Google's building box grown by CUT_GROW */
  const mPx = ll => { const p = utm(ll.lat, ll.lng, zone), [u, v] = pxOf(mask, p.x, p.y); return { x: u, y: v }; };
  const segs = segments || [];
  const seeds = segs.filter(s => s.center).map(s => mPx(s.center));
  const cPx = center ? mPx(center) : { x: mask.w / 2, y: mask.h / 2 };
  let clip = null;
  if (box && box.sw && box.ne) {
    const cs = [[box.sw.lat, box.sw.lng], [box.sw.lat, box.ne.lng], [box.ne.lat, box.sw.lng], [box.ne.lat, box.ne.lng]].map(([la, ln]) => mPx({ lat: la, lng: ln }));
    const gu = CUT_GROW / mask.res, gv = CUT_GROW / mask.resY;
    // a pixel stays when its center is inside the grown box
    clip = {
      u0: Math.ceil(Math.min(...cs.map(c => c.x)) - gu - 0.5), u1: Math.floor(Math.max(...cs.map(c => c.x)) + gu - 0.5),
      v0: Math.ceil(Math.min(...cs.map(c => c.y)) - gv - 0.5), v1: Math.floor(Math.max(...cs.map(c => c.y)) + gv - 0.5),
    };
  }
  const out = roofOutline(mask.data, mask.w, mask.h, seeds, cPx, Math.round(4 / mask.res), Math.max(1.2, 0.3 / mask.res),
    { clip, minHole: Math.round(MIN_HOLE / (mask.res * mask.resY)) });
  if (out.polys.length) {
    result.outline = {
      polys: out.polys.map(p => p.map(([u, v]) => toLL(...utmOfPx(mask, u, v)))),
      areaM2: r2(out.count * mask.res * mask.resY),
      perimeterM: r3(out.polys.reduce((s, p) => s + ringLength(p, mask.res, mask.resY), 0)),
    };
    result.sharedWallM = r3(out.cutX * mask.resY + out.cutY * mask.res);
  }
  if (!result.outline || !dsm || !dsm.zone || dsm.zone.zone !== zone.zone || dsm.zone.south !== zone.south) return result;

  /* roof pixels on the DSM grid (and the neighbour's roof past the cut) */
  const W = dsm.w, H = dsm.h, res = dsm.res, resY = dsm.resY, Z = dsm.data, N = W * H;
  const colM = new Int32Array(W), rowM = new Int32Array(H);
  for (let u = 0; u < W; u++) { const mu = Math.floor((dsm.minX + (u + 0.5) * res - mask.minX) / mask.res); colM[u] = mu >= 0 && mu < mask.w ? mu : -1; }
  for (let v = 0; v < H; v++) { const mv = Math.floor((mask.maxY - (dsm.maxY - (v + 0.5) * resY)) / mask.resY); rowM[v] = mv >= 0 && mv < mask.h ? mv : -1; }
  const roof = new Uint8Array(N), cutPx = new Uint8Array(N);
  let roofCount = 0;
  for (let v = 0; v < H; v++) {
    const mv = rowM[v];
    if (mv < 0) continue;
    for (let u = 0; u < W; u++) {
      const mu = colM[u], i = v * W + u, z = Z[i];
      if (mu < 0) continue;
      const mi = mv * mask.w + mu;
      if (out.isSel(mi) && Number.isFinite(z) && z > -1000) { roof[i] = 1; roofCount++; }
      else if (out.isCut(mi)) cutPx[i] = 1;
    }
  }
  if (!roofCount) return result;
  const X = u => dsm.minX + (u + 0.5) * res, Y = v => dsm.maxY - (v + 0.5) * resY;
  const colOf = x => Math.floor((x - dsm.minX) / res), rowOf = y => Math.floor((dsm.maxY - y) / resY);

  /* plane of each face: its height is the densest band of (height + slope x distance downhill) over the face's
     whole Solar box, so a tree, a dormer or another face at the center can't pull it off; with too few pixels
     there, the heights within FIT_RADIUS of the center; else Google's own plane height (another datum, so the
     face then finds no pixels) */
  const planes = facePlanes(segs, zone);
  for (const f of planes) {
    const along = (x, y) => f.m * ((x - f.cx) * f.dx + (y - f.cy) * f.dy);
    let vals = [];
    const u0 = Math.max(0, colOf(f.bx0)), u1 = Math.min(W - 1, colOf(f.bx1));
    const v0 = Math.max(0, rowOf(f.by1)), v1 = Math.min(H - 1, rowOf(f.by0));
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) { const i = v * W + u; if (roof[i]) vals.push(Z[i] + along(X(u), Y(v))); }
    }
    let z = vals.length >= FIT_MIN ? densestMedian(vals, FIT_WINDOW) : NaN;
    if (!Number.isFinite(z)) {
      vals = [];
      const a0 = Math.max(0, colOf(f.cx - FIT_RADIUS)), a1 = Math.min(W - 1, colOf(f.cx + FIT_RADIUS));
      const b0 = Math.max(0, rowOf(f.cy + FIT_RADIUS)), b1 = Math.min(H - 1, rowOf(f.cy - FIT_RADIUS));
      for (let v = b0; v <= b1; v++) {
        for (let u = a0; u <= a1; u++) {
          const i = v * W + u, x = X(u), y = Y(v);
          if (roof[i] && (x - f.cx) ** 2 + (y - f.cy) ** 2 <= FIT_RADIUS * FIT_RADIUS) vals.push(Z[i] + along(x, y));
        }
      }
      if (vals.length >= 3) z = median(vals);
    }
    if (Number.isFinite(z)) { f.z0 = z; f.fitted = true; result.planeHeights[f.n] = r3(z); }
    else f.z0 = Number.isFinite(f.heightM) ? f.heightM : NaN;
  }
  const live = planes.filter(f => Number.isFinite(f.z0));
  if (!live.length) return result;

  /* label each roof pixel with the face whose plane fits it best */
  let lab = new Uint16Array(N);
  const best = new Float32Array(N).fill(Infinity);
  live.forEach((f, k) => {
    const tol = FIT_TOL + 0.5 * f.m * Math.max(res, resY);
    const u0 = Math.max(0, colOf(f.x0)), u1 = Math.min(W - 1, colOf(f.x1));
    const v0 = Math.max(0, rowOf(f.y1)), v1 = Math.min(H - 1, rowOf(f.y0));
    for (let v = v0; v <= v1; v++) {
      const y = Y(v);
      for (let u = u0; u <= u1; u++) {
        const i = v * W + u;
        if (!roof[i]) continue;
        const r = Math.abs(Z[i] - planeAt(f, X(u), y));
        if (r < tol && r < best[i]) { best[i] = r; lab[i] = k + 1; }
      }
    }
  });
  lab = majorityFilter(lab, roof, W, H, 2);

  /* face shapes: largest blob of each label, traced and simplified */
  const tolPx = Math.max(1.2, 0.3 / Math.min(res, resY));
  const { comp, best: blobs } = largestBlobs(lab, W, H, live.length);
  const counts = new Int32Array(live.length + 1);
  for (let i = 0; i < N; i++) counts[lab[i]]++;
  const facePolys = []; // [{ k, f, poly (UTM, counter-clockwise) }]
  live.forEach((f, k) => {
    const b = blobs[k + 1];
    if (!b) return;
    const inC = (x, y) => x >= 0 && y >= 0 && x < W && y < H && comp[y * W + x] === b.id;
    const tx = b.top % W;
    const ring = traceEdge(inC, tx, (b.top - tx) / W, N).map(([x, y]) => [x + 0.5, y + 0.5]);
    const pxPoly = offsetPoly(straightenClosed(ring, tolPx), 0.5);
    if (pxPoly.length < 3) return;
    let poly = pxPoly.map(([u, v]) => utmOfPx(dsm, u, v));
    if (signedArea(poly) < 0) poly = poly.reverse();
    facePolys.push({ k: k + 1, f, poly });
    result.faces.push({ n: f.n, poly: poly.map(([x, y]) => toLL(x, y)), planM2: r2(counts[k + 1] * res * resY) });
  });
  result.faces.sort((a, b) => a.n - b.n);

  // Label at a point: a face (1..), roof that fits no face (0), off the roof (-1), the neighbour's roof past
  // the cut (-2).
  const labelAt = (x, y) => {
    const u = colOf(x), v = rowOf(y);
    if (u < 0 || v < 0 || u >= W || v >= H) return -1;
    const i = v * W + u;
    return roof[i] ? lab[i] : cutPx[i] ? -2 : -1;
  };
  const dsmAt = (x, y) => {
    const u = colOf(x), v = rowOf(y);
    if (u < 0 || v < 0 || u >= W || v >= H) return NaN;
    const z = Z[v * W + u];
    return Number.isFinite(z) && z > -1000 ? z : NaN;
  };

  const edges = [];

  /* inside edges: boundaries between two faces (4-neighbours, bridging up to 2 unlabeled roof pixels) */
  const pairs = new Map();
  const GAP = 3;
  const keyOf = (a, b) => Math.min(a, b) * 65536 + Math.max(a, b);
  const record = (a, b, ia, ib) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * 65536 + hi;
    let p = pairs.get(key);
    if (!p) { p = { a: lo, b: hi, pts: [], sx: 0, sy: 0 }; pairs.set(key, p); }
    const ua = ia % W, va = (ia - ua) / W, ub = ib % W, vb = (ib - ub) / W;
    p.pts.push(X((ua + ub) / 2), Y((va + vb) / 2));
    // side: from the higher label's pixel toward the lower label's pixel (face a = lower label)
    const s = a === lo ? 1 : -1;
    p.sx += s * (X(ua) - X(ub)); p.sy += s * (Y(va) - Y(vb));
  };
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u, a = lab[i];
      if (!a) continue;
      for (let k = 1; k <= GAP && u + k < W; k++) {
        const j = i + k;
        if (!roof[j] || lab[j] === a) break;
        if (lab[j]) { record(a, lab[j], i, j); break; }
      }
      for (let k = 1; k <= GAP && v + k < H; k++) {
        const j = i + k * W;
        if (!roof[j] || lab[j] === a) break;
        if (lab[j]) { record(a, lab[j], i, j); break; }
      }
    }
  }
  const pxM = Math.max(res, resY);
  const touching = new Set();
  for (const p of pairs.values()) if (p.pts.length >= 6) touching.add(`${p.a},${p.b}`).add(`${p.b},${p.a}`);
  // Faces that meet with a height jump (a lower roof against a higher one, a dormer's cheek walls): each face
  // types its own side of that line in the walk below, so these pairs give no inside edge. Value: the lower face.
  const jumpLower = new Map();
  for (const p of pairs.values()) {
    const fa = live[p.a - 1], fb = live[p.b - 1];
    if (p.pts.length < 6) continue;
    const jumps = [];
    let below = 0;
    for (let i = 0; i < p.pts.length; i += 2) {
      const dz = planeAt(fa, p.pts[i], p.pts[i + 1]) - planeAt(fb, p.pts[i], p.pts[i + 1]);
      jumps.push(Math.abs(dz)); below += dz < 0 ? 1 : 0;
    }
    if (median(jumps) > STEP_JUMP) { jumpLower.set(keyOf(p.a, p.b), below * 2 >= jumps.length ? p.a : p.b); continue; }
    const g = lineOfPair({ fa, fb, pts: p.pts, gap: Math.max(4 * pxM, 0.6) });
    const [tx, ty] = g.t;
    // Unit vector across the line, toward face a.
    let nx = -ty, ny = tx;
    if (nx * p.sx + ny * p.sy < 0) { nx = -nx; ny = -ny; }
    const awayA = fa.m * (fa.dx * nx + fa.dy * ny), awayB = -fb.m * (fb.dx * nx + fb.dy * ny);
    const slopeOf = f => f.m * (f.dx * tx + f.dy * ty);
    // Below EPS a face's fall across the line is noise; very low-slope faces (a flat roof's crown) get a
    // smaller EPS so their crown still reads as a ridge.
    const EPS = fa.m >= FLAT_SLOPE && fb.m >= FLAT_SLOPE ? Math.min(0.03, 0.4 * Math.min(fa.m, fb.m)) : 0.03;
    const s = (slopeOf(fa) + slopeOf(fb)) / 2;
    let type;
    if (awayA > EPS && awayB > EPS) type = Math.abs(s) < LEVEL_SLOPE ? 'ridge' : 'hip';
    else if (awayA < -EPS && awayB < -EPS) type = 'valley';
    else type = 'break';
    for (const run of g.runs) {
      // The trimmed span covers 96% of evenly spread points; scale it back, plus the half pixel at each end.
      let plan = (run.hi - run.lo) / (1 - 2 * TRIM) + pxM;
      // A real shared edge has a boundary point for about every pixel along it; scattered specks do not.
      if (plan < MIN_EDGE || run.n < 0.5 * plan / pxM) continue;
      let e0 = (run.lo + run.hi) / 2 - plan / 2, e1 = e0 + plan;
      const D = [fa.m * fa.dx - fb.m * fb.dx, fa.m * fa.dy - fb.m * fb.dy], D2 = D[0] * D[0] + D[1] * D[1];
      if ((type === 'ridge' || type === 'hip' || type === 'valley') && D2 > 0.0025) {
        // Where a third face that touches both cuts this line (a ridge end, the top of a hip or valley), the
        // three planes say exactly where the line stops. The pixel boundary overshoots there by a pixel or two.
        const ga = [fa.m * fa.dx, fa.m * fa.dy], hAB = planeAt(fa, g.mx, g.my) - planeAt(fb, g.mx, g.my);
        const p0 = [g.mx + D[0] * hAB / D2, g.my + D[1] * hAB / D2]; // on the line where the two planes meet
        const reach = Math.min(Math.max(3 * pxM, 0.6), 0.3 * plan);
        const cuts = [];
        live.forEach((fc, kc) => {
          const c = kc + 1;
          if (c === p.a || c === p.b || !touching.has(`${p.a},${c}`) || !touching.has(`${p.b},${c}`)) return;
          const den = (ga[0] - fc.m * fc.dx) * tx + (ga[1] - fc.m * fc.dy) * ty;
          if (Math.abs(den) < 0.05) return;
          cuts.push((planeAt(fa, p0[0], p0[1]) - planeAt(fc, p0[0], p0[1])) / den);
        });
        const snap = e => {
          let bst = e, bd = reach;
          for (const c of cuts) { const d = Math.abs(c - e); if (d <= bd) { bd = d; bst = c; } }
          return bst;
        };
        const s0 = snap(e0), s1 = snap(e1);
        if (s1 - s0 >= MIN_EDGE) { e0 = s0; e1 = s1; plan = e1 - e0; }
      }
      const ax = g.mx + tx * e0, ay = g.my + ty * e0, bx = g.mx + tx * e1, by = g.my + ty * e1;
      edges.push({ type, faces: [fa.n, fb.n].sort((x, y) => x - y), planM: plan, lengthM: plan * Math.sqrt(1 + s * s), path: [[ax, ay], [bx, by]] });
    }
  }

  /* each face's own sides: walk outward from every side of its shape. Another face out there with no height
     jump: an inside edge (above). A higher face or a higher roof part with no face (a wall): this face's step
     or headwall. A lower face: this face's eave or rake (it still gets drip edge). The neighbour's roof past
     the cut: no edge at all (party wall). Off the roof: an outer edge, on the outline. */
  const SAMPLE = 0.25, CORNER = 3 * pxM;
  const walkSteps = Math.ceil(tolPx) + 3;
  const SKIP = 0, OUT = 1, UP = 2, DOWN = 3;
  const perim = {};
  for (const { k: own, f, poly } of facePolys) {
    const flat = f.m < FLAT_SLOPE;
    const pieces = [];
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      const tx = (bx - ax) / L, ty = (by - ay) / L;
      const ox = ty, oy = -tx; // outward for a counter-clockwise ring (x east, y north)
      const ns = Math.max(2, Math.ceil(L / SAMPLE));
      const cat = new Uint8Array(ns), offRoof = new Uint8Array(ns), other = new Int32Array(ns);
      const outZ = new Float64Array(ns).fill(NaN), inZ = new Float64Array(ns);
      for (let k = 0; k < ns; k++) {
        const sx = ax + tx * (k + 0.5) * L / ns, sy = ay + ty * (k + 0.5) * L / ns;
        inZ[k] = planeAt(f, sx, sy);
        // Walk outward past this face's own pixels (the simplified side can cut inside it) and past at most
        // GAP pixels that fit no face, the same gap the inside edges bridge.
        let decided = false, zOut = NaN, zeros = 0;
        for (let st = 0; st < walkSteps; st++) {
          const d = (st + 0.5) * pxM, qx = sx + ox * d, qy = sy + oy * d, l = labelAt(qx, qy);
          if (l === own) continue;
          if (l === -2) { cat[k] = SKIP; decided = true; break; }
          if (l > 0) {
            const lower = jumpLower.get(keyOf(own, l));
            cat[k] = lower == null ? SKIP : lower === own ? UP : DOWN;
            other[k] = l; decided = true; break;
          }
          // non-roof (-1) or roof that fits no face (0): sample the height a pixel further out
          zOut = dsmAt(qx + ox * pxM, qy + oy * pxM);
          if (l === -1) { cat[k] = OUT; offRoof[k] = 1; decided = true; break; }
          if (++zeros > GAP) { cat[k] = OUT; decided = true; break; }
        }
        if (!decided) { cat[k] = OUT; offRoof[k] = 1; }
        outZ[k] = zOut;
      }
      // Near a corner the walk can slip past the thin tip of the next face (the filter rounds acute tips
      // off), so samples within a few pixels of either end follow the nearest sample further in.
      const k0 = Math.ceil(CORNER / (L / ns) - 0.5), k1 = ns - 1 - k0;
      if (k0 <= k1) {
        const copy = (k, from) => { cat[k] = cat[from]; offRoof[k] = offRoof[from]; other[k] = other[from]; if (!Number.isFinite(outZ[k])) outZ[k] = outZ[from]; };
        for (let k = 0; k < k0; k++) copy(k, k0);
        for (let k = k1 + 1; k < ns; k++) copy(k, k1);
      }
      const dot = f.dx * tx + f.dy * ty, outDown = f.dx * ox + f.dy * oy, along = Math.abs(dot) >= RAKE_DOT;
      const s = flat ? 0 : f.m * dot;
      // runs of one kind of sample become pieces of this side
      let k = 0;
      while (k < ns) {
        const c = cat[k];
        let e = k;
        while (e < ns && cat[e] === c) e++;
        if (c === SKIP) { k = e; continue; }
        let type, faces = [f.n], onOutline = false;
        if (c === UP) {
          // this face is the lower one: its side runs into a wall
          type = !flat && along ? 'step' : 'headwall';
          const votes = new Map();
          for (let q = k; q < e; q++) votes.set(other[q], (votes.get(other[q]) || 0) + 1);
          const o = [...votes].sort((x, y) => y[1] - x[1])[0][0];
          faces = [f.n, live[o - 1].n].sort((x, y) => x - y);
        } else if (c === DOWN) {
          type = flat ? 'eave' : along ? 'rake' : outDown > 0 ? 'eave' : 'ridge';
        } else {
          // Outside height first: a side against a higher roof part with no face of its own is a wall.
          // Only samples that land on roof count, so a tree beside a rake doesn't make it a step.
          const zo = [], zi = [];
          let off = 0;
          for (let q = k; q < e; q++) {
            off += offRoof[q];
            if (!offRoof[q] && Number.isFinite(outZ[q])) { zo.push(outZ[q]); zi.push(inZ[q]); }
          }
          const wall = zo.length * 2 >= e - k && median(zo) - median(zi) > STEP_JUMP;
          if (wall) type = !flat && along ? 'step' : 'headwall';
          else type = flat ? 'eave' : along ? 'rake' : outDown > 0 ? 'eave' : 'ridge';
          onOutline = off * 2 > e - k;
        }
        const plan = (e - k) * L / ns;
        if (onOutline) perim[f.n] = (perim[f.n] || 0) + plan;
        const last = pieces[pieces.length - 1];
        if (last && last.side === i && last.type === type && last.kEnd === k) {
          // one type along one side is one edge (a corner of the walk can see the wall a pixel early)
          if (plan > last.plan) last.faces = faces;
          last.plan += plan; last.len += plan * Math.sqrt(1 + s * s); last.b = [ax + tx * e * L / ns, ay + ty * e * L / ns]; last.kEnd = e; last.atEnd = e === ns;
        } else {
          pieces.push({
            type, faces, plan, len: plan * Math.sqrt(1 + s * s), tx, ty, side: i, kEnd: e,
            atStart: k === 0, atEnd: e === ns,
            a: [ax + tx * k * L / ns, ay + ty * k * L / ns], b: [ax + tx * e * L / ns, ay + ty * e * L / ns],
          });
        }
        k = e;
      }
    }
    // merge neighbouring pieces of one type that continue in nearly the same direction
    const joinable = (p, q) => p.type === q.type && p.atEnd && q.atStart && p.side !== q.side && (p.tx * q.tx + p.ty * q.ty) > Math.cos(20 * D2R);
    const merged = [];
    for (const p of pieces) {
      const last = merged[merged.length - 1];
      if (last && joinable(last, p)) { last.plan += p.plan; last.len += p.len; last.b = p.b; last.atEnd = p.atEnd; last.side = p.side; last.tx = p.tx; last.ty = p.ty; }
      else merged.push({ ...p });
    }
    if (merged.length > 1) {
      const first = merged[0], last = merged[merged.length - 1];
      if (joinable(last, first)) { last.plan += first.plan; last.len += first.len; last.b = first.b; merged.shift(); }
    }
    for (const p of merged) edges.push({ type: p.type, faces: p.faces, planM: p.plan, lengthM: p.len, path: [p.a, p.b] });
  }
  for (const n of Object.keys(perim)) result.perimeterByFaceM[n] = r3(perim[n]);

  result.edges = edges
    .filter(e => e.planM >= MIN_EDGE)
    .map(e => ({ type: e.type, faces: e.faces, lengthM: r3(e.lengthM), planM: r3(e.planM), path: e.path.map(([x, y]) => toLL(x, y)) }))
    .sort((a, b) => EDGE_TYPES.indexOf(a.type) - EDGE_TYPES.indexOf(b.type) || b.lengthM - a.lengthM);
  for (const e of result.edges) result.edgeTotalsM[e.type] += e.lengthM;
  for (const t of EDGE_TYPES) result.edgeTotalsM[t] = r3(result.edgeTotalsM[t]);
  return result;
}

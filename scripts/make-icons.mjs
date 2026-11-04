// Rasterises the AtticScan icon (a roof over insulation layers) to PNG without dependencies:
// a tiny scanline painter plus a hand-rolled PNG encoder. Run: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const TEAL = [15, 118, 110], WHITE = [255, 255, 255], PINK = [249, 168, 212], PINK2 = [251, 200, 228];

/** Shapes in a 512×512 design space: [kind, colour, ...coords]. */
function paint(size, { rounded, inset }) {
  const px = new Uint8Array(size * size * 4);
  const k = size / 512;
  // Maskable icons keep content inside the central 80% safe zone.
  const s = inset ? 0.72 : 1;
  const o = (512 - 512 * s) / 2;
  const T = (x, y) => [(o + x * s) * k, (o + y * s) * k];
  const roof = [T(256, 104), T(432, 264), T(80, 264)];
  const rects = [
    [PINK, T(136, 264), T(376, 304)],
    [PINK2, T(136, 316), T(376, 344)],
    [WHITE, T(120, 360), T(392, 408)],
  ];
  const inTri = (x, y, [a, b, c]) => {
    const d = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
    const d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const r = rounded ? 96 * k : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // Rounded-corner background (transparent outside), full square for maskable/apple.
      const dx = Math.max(r - cx, cx - (size - r), 0), dy = Math.max(r - cy, cy - (size - r), 0);
      if (r && dx * dx + dy * dy > r * r) continue;
      let c = TEAL;
      if (inTri(cx, cy, roof)) c = WHITE;
      for (const [col, a, b] of rects) if (cx >= a[0] && cx < b[0] && cy >= a[1] && cy < b[1]) c = col;
      const i = (y * size + x) * 4;
      px.set([...c, 255], i);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../public/icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', out), paint(192, { rounded: true }));
writeFileSync(new URL('icon-512.png', out), paint(512, { rounded: true }));
writeFileSync(new URL('icon-maskable-512.png', out), paint(512, { inset: true }));
// iOS adds its own rounded corners and dislikes transparency.
writeFileSync(new URL('apple-touch-icon.png', out), paint(180, {}));
console.log('icons written');

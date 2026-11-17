// A small uncompressed GeoTIFF writer for the mock Google. Dev only.
// (geotiff.js's writeArrayBuffer only writes 8-bit samples, so it can't make the float32 surface heights.)
//
// Writes one strip, chunky (interleaved) samples, little-endian, with ModelPixelScale, ModelTiepoint and a
// GeoKeyDirectory naming the projected system (EPSG 326xx / 327xx for UTM), like Google's Solar files.

const SHORT = 3, LONG = 4, DOUBLE = 12, ASCII = 2;
const SIZE = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [ASCII]: 1 };

/**
 * r: { w, h, res, resY, minX, maxY, zone: { zone, south }, data: Uint8Array | Float32Array, bands? }
 * opts.epsg overrides the projection code (to test files in an unexpected projection).
 * opts.noData writes a GDAL no-data value.
 */
export function encodeGeoTiff(r, opts = {}) {
  const bands = r.bands || 1;
  const isFloat = r.data instanceof Float32Array;
  const bps = isFloat ? 32 : 8, bytes = bps / 8;
  const imgBytes = r.w * r.h * bands * bytes;
  if (r.data.length !== r.w * r.h * bands) throw new Error('raster size mismatch');
  const epsg = opts.epsg || (r.zone.south ? 32700 : 32600) + r.zone.zone;
  const geoKeys = epsg >= 32601 && epsg <= 32760
    ? [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg, 3076, 0, 1, 9001]
    : [1, 1, 0, 3, 1024, 0, 1, epsg === 4326 ? 2 : 1, 1025, 0, 1, 1, epsg === 4326 ? 2048 : 3072, 0, 1, epsg];
  const entries = [
    [256, LONG, [r.w]],
    [257, LONG, [r.h]],
    [258, SHORT, new Array(bands).fill(bps)],
    [259, SHORT, [1]],
    [262, SHORT, [bands === 3 ? 2 : 1]],
    [273, LONG, [0]], // patched below
    [277, SHORT, [bands]],
    [278, LONG, [r.h]],
    [279, LONG, [imgBytes]],
    [284, SHORT, [1]],
    [339, SHORT, new Array(bands).fill(isFloat ? 3 : 1)],
    [33550, DOUBLE, [r.res, r.resY, 0]],
    [33922, DOUBLE, [0, 0, 0, r.minX, r.maxY, 0]],
    [34735, SHORT, geoKeys],
  ];
  if (opts.noData != null) entries.push([42113, ASCII, `${opts.noData}\0`]);
  entries.sort((a, b) => a[0] - b[0]);

  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const placed = entries.map(([tag, type, vals]) => {
    const n = vals.length, len = n * SIZE[type];
    let off = null;
    if (len > 4) { off = extra; extra += len + (len & 1); }
    return { tag, type, vals, n, off };
  });
  const dataOff = extra + ((8 - (extra % 8)) % 8);
  placed.find(e => e.tag === 273).vals = [dataOff];

  const buf = Buffer.alloc(dataOff + imgBytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf.write('II', 0, 'latin1'); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, placed.length, true);
  const put = (type, at, v) => {
    if (type === SHORT) dv.setUint16(at, v, true);
    else if (type === LONG) dv.setUint32(at, v, true);
    else if (type === DOUBLE) dv.setFloat64(at, v, true);
    else dv.setUint8(at, v.charCodeAt(0));
  };
  placed.forEach((e, i) => {
    const at = 10 + i * 12;
    dv.setUint16(at, e.tag, true); dv.setUint16(at + 2, e.type, true); dv.setUint32(at + 4, e.n, true);
    const base = e.off == null ? at + 8 : e.off;
    if (e.off != null) dv.setUint32(at + 8, e.off, true);
    for (let k = 0; k < e.n; k++) put(e.type, base + k * SIZE[e.type], e.type === ASCII ? e.vals[k] : e.vals[k]);
  });
  dv.setUint32(10 + placed.length * 12, 0, true);
  if (isFloat) for (let i = 0; i < r.data.length; i++) dv.setFloat32(dataOff + i * 4, r.data[i], true);
  else buf.set(r.data, dataOff);
  return buf;
}

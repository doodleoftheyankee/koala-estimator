// Reads one of Google's GeoTIFF files (rooftop mask or surface heights) into a plain raster for lib/takeoff.js.
import { fromArrayBuffer } from 'geotiff';
import { utmZoneOf } from './takeoff.js';

/**
 * Returns { w, h, res, resY, minX, maxY, zone, keys, data } where data is the first band.
 * zone is null when the file is not in a UTM projection (the caller decides what to do).
 * Pixels equal to the file's no-data value become NaN in floating-point bands.
 */
export async function readGeoTiff(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const tiff = await fromArrayBuffer(ab);
  const img = await tiff.getImage();
  const w = img.getWidth(), h = img.getHeight();
  const [minX, minY, maxX, maxY] = img.getBoundingBox();
  const keys = img.getGeoKeys() || {};
  const data = (await img.readRasters({ samples: [0] }))[0];
  const noData = img.getGDALNoData();
  if (noData != null && (data instanceof Float32Array || data instanceof Float64Array)) {
    for (let i = 0; i < data.length; i++) if (data[i] === noData) data[i] = NaN;
  }
  return { w, h, res: (maxX - minX) / w, resY: (maxY - minY) / h, minX, maxY, zone: utmZoneOf(keys), keys, data };
}

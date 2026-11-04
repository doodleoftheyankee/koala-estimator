// Shared rules for area photos (phone and server). Pure.

/** Photos per estimate area. */
export const MAX_PHOTOS_PER_AREA = 6;

/** Largest upload the server accepts. Phones shrink photos to ~2000px JPEG (~0.5 MB) first. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Where a photo lives in the private "photos" storage bucket. */
export function photoPath(estimateId: string, photoId: string): string {
  return `${estimateId}/${photoId}.jpg`;
}

/** A photo as the server lists it for an estimate (URLs are short-lived signed links). */
export interface RemotePhoto {
  id: string;
  areaId: string | null;
  takenAt: string | null;
  url: string;
}

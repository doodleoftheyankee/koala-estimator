// Photo capture helpers: downscale on the phone before storing (a 12 MP photo is ~4 MB; 2000px
// JPEG is ~400 KB), make a thumbnail, and the placeholder for future photo analysis.

import { addPhoto, type PhotoRecord } from './db';
import { uid } from './model';

export const MAX_PHOTOS_PER_SPACE = 6;

/** Decodes an image file. Browsers apply the photo's EXIF rotation when drawing an <img>. */
function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read ${file instanceof File ? file.name : 'the photo'}. Is it an image?`));
    };
    img.src = url;
  });
}

function resize(img: HTMLImageElement, maxSide: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress the photo.'))), 'image/jpeg', quality),
  );
}

/** Stores one photo for a space: a 2000px copy plus a 320px thumbnail. */
export async function savePhoto(file: File, jobId: string, spaceId: string): Promise<PhotoRecord> {
  const img = await loadImage(file);
  const [blob, thumb] = await Promise.all([resize(img, 2000, 0.82), resize(img, 320, 0.7)]);
  const record: PhotoRecord = { id: uid(), jobId, spaceId, createdAt: Date.now(), blob, thumb, name: file.name };
  await addPhoto(record);
  return record;
}

export interface PhotoAnalysis {
  /** Suggested dimensions or square footage, per photo. */
  suggestions: Array<{ photoId: string; note: string }>;
}

/**
 * Placeholder for automatic photo analysis (e.g. estimating joist spacing, existing insulation
 * depth, or room dimensions from a reference object). Not implemented yet: it always resolves
 * to null, and the UI says so. Wire a vision model in here later; the photos are already
 * stored per space with their IDs.
 */
export async function analyzePhotos(photos: PhotoRecord[]): Promise<PhotoAnalysis | null> {
  void photos;
  return null;
}

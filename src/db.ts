// IndexedDB storage. Two stores: whole jobs (small JSON) and photos (blobs), kept apart so
// saving a job on every keystroke never rewrites megabytes of images.

import type { Job } from './model';

const DB_NAME = 'atticscan';
const DB_VERSION = 1;

export interface PhotoRecord {
  id: string;
  jobId: string;
  spaceId: string;
  createdAt: number;
  /** Downscaled photo (max 2000px JPEG). */
  blob: Blob;
  /** Small square-ish preview for the thumbnail grid. */
  thumb: Blob;
  name: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('spaceId', 'spaceId');
        photos.createIndex('jobId', 'jobId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Runs one request in its own transaction and resolves with its result. */
async function run<T>(store: 'jobs' | 'photos', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}

export async function listJobs(): Promise<Job[]> {
  const jobs = await run<Job[]>('jobs', 'readonly', (s) => s.getAll());
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getJob(id: string): Promise<Job | undefined> {
  return run<Job | undefined>('jobs', 'readonly', (s) => s.get(id));
}

export async function saveJob(job: Job): Promise<void> {
  job.updatedAt = Date.now();
  // Structured clone of a plain object: strip anything non-serialisable by round-tripping JSON.
  await run('jobs', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(job))));
}

export async function deleteJob(id: string): Promise<void> {
  await run('jobs', 'readwrite', (s) => s.delete(id));
  await deletePhotosWhere('jobId', id);
}

export function listPhotos(spaceId: string): Promise<PhotoRecord[]> {
  return run<PhotoRecord[]>('photos', 'readonly', (s) => s.index('spaceId').getAll(spaceId)).then((p) =>
    p.sort((a, b) => a.createdAt - b.createdAt),
  );
}

export function countPhotos(spaceId: string): Promise<number> {
  return run<number>('photos', 'readonly', (s) => s.index('spaceId').count(spaceId));
}

export async function addPhoto(photo: PhotoRecord): Promise<void> {
  await run('photos', 'readwrite', (s) => s.put(photo));
}

export async function deletePhoto(id: string): Promise<void> {
  await run('photos', 'readwrite', (s) => s.delete(id));
}

export function deleteSpacePhotos(spaceId: string): Promise<void> {
  return deletePhotosWhere('spaceId', spaceId);
}

async function deletePhotosWhere(index: 'jobId' | 'spaceId', value: string): Promise<void> {
  const keys = await run<IDBValidKey[]>('photos', 'readonly', (s) => s.index(index).getAllKeys(value));
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    keys.forEach((k) => tx.objectStore('photos').delete(k));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Asks the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported: data still saves, it's just evictable */
  }
}

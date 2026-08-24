import type { TelemetryPoint } from '@wolfbox/telemetry';

/**
 * Persists decoded telemetry so a card is only ever read once.
 *
 * Extracting GPS costs ~700ms per clip because the samples are interleaved
 * through `mdat`; a full card is roughly nine minutes of reading. Cached by
 * name+size+lastModified so a re-inserted card is instant and an overwritten
 * clip (the camera loops) is re-read.
 */

const DB_NAME = 'wolfbox-player';
const STORE = 'telemetry';
const VERSION = 1;

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

export function cacheKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const request = run(database.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCached(key: string): Promise<TelemetryPoint[] | undefined> {
  try {
    return await transact('readonly', (store) => store.get(key));
  } catch {
    // A private window or blocked storage must not break playback.
    return undefined;
  }
}

export async function writeCached(key: string, points: TelemetryPoint[]): Promise<void> {
  try {
    await transact('readwrite', (store) => store.put(points, key) as IDBRequest<unknown> as IDBRequest<void>);
  } catch {
    // Caching is an optimisation; losing it is not a failure.
  }
}

export async function clearCache(): Promise<void> {
  try {
    await transact('readwrite', (store) => store.clear() as IDBRequest<unknown> as IDBRequest<void>);
  } catch { /* nothing to do */ }
}

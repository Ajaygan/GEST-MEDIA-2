/**
 * Loads the MediaPipe hand-landmarker model.
 *
 * Order of preference:
 *   1. the copy bundled with the extension (`vendor/models/hand_landmarker.task`,
 *      put there by `npm run setup`) — works fully offline
 *   2. a copy previously downloaded and cached in IndexedDB
 *   3. a one-time download from Google's model host, which is then cached
 *
 * Only *data* is ever fetched — no remote code, so this stays MV3 compliant.
 */

import { MODEL_LOCAL_PATH, MODEL_REMOTE_URL } from './constants.js';

const DB_NAME = 'gestmedia';
const STORE = 'models';
const KEY = 'hand_landmarker.task';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readCache() {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeCache(buffer) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(buffer, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* caching is best effort */
  }
}

/**
 * @param {(stage: string) => void} [onProgress]
 * @returns {Promise<{buffer: Uint8Array, source: 'bundled'|'cache'|'download'}>}
 */
export async function loadModel(onProgress = () => {}) {
  onProgress('bundled');
  try {
    const res = await fetch(chrome.runtime.getURL(MODEL_LOCAL_PATH));
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > 100_000) return { buffer: buf, source: 'bundled' };
    }
  } catch {
    /* not bundled — fall through */
  }

  onProgress('cache');
  const cached = await readCache();
  if (cached && cached.byteLength > 100_000) {
    return { buffer: new Uint8Array(cached), source: 'cache' };
  }

  onProgress('download');
  const res = await fetch(MODEL_REMOTE_URL, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  await writeCache(arrayBuffer);
  return { buffer: new Uint8Array(arrayBuffer), source: 'download' };
}

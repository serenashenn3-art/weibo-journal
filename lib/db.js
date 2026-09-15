const DB_NAME = 'weibo-journal';
const DB_VERSION = 1;

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('posts')) {
        const s = db.createObjectStore('posts', { keyPath: 'mid' });
        s.createIndex('created_at', 'created_at');
        s.createIndex('source', 'source');
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function idb(store, mode, op) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let request = null;
    try {
      request = op(t.objectStore(store));
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    if (request) request.onsuccess = () => { result = request.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putPost = (p) => idb('posts', 'readwrite', (s) => s.put(p));
export const getPost = (mid) => idb('posts', 'readonly', (s) => s.get(mid));
export const allPosts = () => idb('posts', 'readonly', (s) => s.getAll());
export const countPosts = () => idb('posts', 'readonly', (s) => s.count());
export const clearPosts = () => idb('posts', 'readwrite', (s) => s.clear());

export const putMedia = (m) => idb('media', 'readwrite', (s) => s.put(m));
export const getMedia = (url) => idb('media', 'readonly', (s) => s.get(url));
export const allMediaKeys = () => idb('media', 'readonly', (s) => s.getAllKeys());
export const clearMedia = () => idb('media', 'readwrite', (s) => s.clear());

export const setMeta = (key, value) => idb('meta', 'readwrite', (s) => s.put({ key, value }));
export const getMeta = (key) => idb('meta', 'readonly', (s) => s.get(key)).then((r) => (r ? r.value : undefined));

export async function resetAll() {
  await clearPosts();
  await clearMedia();
  await setMeta('checkpoint', null);
  await setMeta('stats', null);
  await setMeta('running', null);
  await setMeta('failedMedia', []);
}

export async function deleteDatabase() {
  if (_dbPromise) {
    const db = await _dbPromise;
    db.close();
    _dbPromise = null;
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('delete blocked'));
  });
}

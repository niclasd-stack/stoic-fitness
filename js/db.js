// Lokaler Speicher (IndexedDB). Alles wird zuerst hier geschrieben, dann synchronisiert.
// Eigener Name, weil das Journal auf derselben Origin (github.io) liegt.
let DB_NAME = 'stoic-fitness';
// Testmodus (?lokal auf localhost) bekommt eine eigene Datenbank, damit Testdaten nie synchronisiert werden.
export function useName(name) { DB_NAME = name; }
const DB_VERSION = 1;
export const STORES = ['fit_workouts', 'fit_body', 'fit_habits', 'fit_habit_log', 'fit_settings'];
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; location.reload(); };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => window.dispatchEvent(new Event('db-blocked'));
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const get = (store, id) => run(store, 'readonly', s => s.get(id));
export const put = (store, obj) => run(store, 'readwrite', s => s.put(obj));
export const all = (store) => run(store, 'readonly', s => s.getAll());
export const live = async (store) => (await all(store)).filter(x => !x.deleted);
export const dirty = async (store) => (await all(store)).filter(x => x.dirty);

// Ändern = lokal speichern, als „dirty“ markieren, später synchronisieren.
export function save(store, obj) {
  const rec = { ...obj, updated_at: new Date().toISOString(), dirty: true };
  return put(store, rec).then(() => { window.dispatchEvent(new Event('local-change')); return rec; });
}
export const remove = (store, obj) => save(store, { ...obj, deleted: true });

export const getMeta = key => run('meta', 'readonly', s => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', s => s.put(value, key));

export async function pendingCount() {
  let n = 0;
  for (const s of STORES) n += (await dirty(s)).length;
  return n;
}

export async function clearAll() {
  for (const store of [...STORES, 'meta']) await run(store, 'readwrite', s => s.clear());
}

export const uuid = () => crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });

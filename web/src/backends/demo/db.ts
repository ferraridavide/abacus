// A small IndexedDB store for the demo: item and folder records, and the files and thumbnails as blobs.
// IndexedDB keeps blobs on disk, where localStorage would only take a few megabytes of strings.
// Without IndexedDB (some private windows) the demo still runs, in memory until the page is closed.

const NAME = 'abacus-demo';
export type StoreName = 'items' | 'folders' | 'blobs' | 'meta';
const STORES: StoreName[] = ['items', 'folders', 'blobs', 'meta'];

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export interface DemoDb {
  all<T>(store: StoreName): Promise<T[]>;
  entries<T>(store: StoreName): Promise<[string, T][]>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  remove(store: StoreName, keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

export async function openDemoDb(): Promise<DemoDb> {
  let db: IDBDatabase;
  try {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    db = await done(req);
  } catch (e) {
    console.warn('Demo: IndexedDB is unavailable, the library lives in memory only', e);
    return memoryDb();
  }
  // ask the browser not to evict the demo library under storage pressure
  navigator.storage?.persist?.().catch(() => {});

  const run = (store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void) =>
    new Promise<void>((resolve, reject) => {
      const t = db.transaction(store, mode);
      fn(t.objectStore(store));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });

  return {
    all: (store) => done(db.transaction(store).objectStore(store).getAll()),
    entries: async <T>(store: StoreName) => {
      // both lists come back in key order
      const s = db.transaction(store).objectStore(store);
      const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
      return keys.map((k, i) => [String(k), values[i] as T] as [string, T]);
    },
    put: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
    remove: (store, keys) => run(store, 'readwrite', (s) => keys.forEach((k) => s.delete(k))),
    clear: async () => {
      for (const store of STORES) await run(store, 'readwrite', (s) => s.clear());
    },
  };
}

function memoryDb(): DemoDb {
  const data = Object.fromEntries(STORES.map((s) => [s, new Map<string, unknown>()])) as Record<StoreName, Map<string, unknown>>;
  return {
    all: async <T>(store: StoreName) => [...data[store].values()] as T[],
    entries: async <T>(store: StoreName) => [...data[store].entries()] as [string, T][],
    put: async (store, key, value) => void data[store].set(key, value),
    remove: async (store, keys) => keys.forEach((k) => data[store].delete(k)),
    clear: async () => STORES.forEach((s) => data[s].clear()),
  };
}

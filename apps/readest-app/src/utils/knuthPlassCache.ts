/**
 * Persistent cache of Knuth–Plass line breaks, so a book reopened on the same
 * device and settings is set without measuring or breaking anything again.
 * One IndexedDB record per book section maps each paragraph's fingerprint (its
 * text and everything its lines were measured against) to its break markers.
 * Only the most recently used sections are kept.
 */

const DB_NAME = 'KnuthPlassLayouts';
const DB_VERSION = 1;
const STORE_NAME = 'sections';
const MAX_SECTIONS = 300;

type SectionRecord = { key: string; updated: number; layouts: [string, number[]][] };

let database: Promise<IDBDatabase> | null = null;

const openDatabase = (): Promise<IDBDatabase> => {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      store.createIndex('updated', 'updated');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = null;
      reject(request.error);
    };
  });
  return database;
};

const settle = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** The cached layouts of a section, or none if it was never set here. */
export const loadLayouts = async (key: string): Promise<Map<string, number[]>> => {
  try {
    const db = await openDatabase();
    const record = await settle<SectionRecord | undefined>(
      db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key),
    );
    return new Map(record?.layouts);
  } catch (error) {
    console.warn('Failed to load line-break cache', error);
    return new Map();
  }
};

/** Replace a section's cached layouts, dropping the least recently set sections. */
export const saveLayouts = async (key: string, layouts: Map<string, number[]>) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put({ key, updated: Date.now(), layouts: [...layouts] } satisfies SectionRecord);
    let excess = (await settle(store.count())) - MAX_SECTIONS;
    if (excess > 0) {
      const cursor = store.index('updated').openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result || excess-- <= 0) return;
        cursor.result.delete();
        cursor.result.continue();
      };
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (error) {
    console.warn('Failed to save line-break cache', error);
  }
};

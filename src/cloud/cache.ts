import type { CloudSnapshot } from './types';
import { parseSnapshot } from './schema';

const DB = 'token-view-private-v1';
const STORE = 'snapshots';
let connection: Promise<IDBDatabase> | undefined;
let mutations: Promise<void> = Promise.resolve();
function serialize(task: () => Promise<void>) {
  const operation = mutations.then(task, task);
  mutations = operation.catch(() => {});
  return operation;
}
function open() {
  return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(new Error('기기 저장소를 사용할 수 없어요.')); };
  });
}

export async function readCache(key: string): Promise<CloudSnapshot | null> {
  try {
    const db = await open();
    const value = await new Promise<unknown>((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    return value ? parseSnapshot(value) : null;
  } catch { return null; }
}

export async function writeCache(key: string, value: CloudSnapshot) {
  return serialize(async () => {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('기기에 데이터를 저장하지 못했어요.')); tx.onabort = () => reject(new Error('기기 저장이 중단됐어요.'));
  });
  });
}

export async function clearCache() {
  return serialize(async () => {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('기기 데이터를 지우지 못했어요.'));
  });
  });
}

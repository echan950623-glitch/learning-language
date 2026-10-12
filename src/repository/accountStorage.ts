/** One atomic, account-owned snapshot. Legacy keys are retained as recovery copies. */
export interface AccountSnapshot {
  format: 1;
  owner: string | null;
  revision: number;
  values: Record<string, string>;
}
let owner: string | null = null;
let generation = 0;
let transaction: AccountSnapshot | null = null;
let lockHeld = false;
let lockOwner: string | null = null;
let lockGeneration = 0;
const listeners = new Set<() => void>();
const durableSnapshots = new Map<string, AccountSnapshot>();
let writingTransaction: IDBTransaction | null = null;
let databasePromise: Promise<IDBDatabase> | null = null;
let databaseConnection: IDBDatabase | null = null;
function validateSnapshot(value: unknown, id: string | null): AccountSnapshot {
  const snapshot = value as AccountSnapshot | null;
  if (!snapshot || snapshot.format !== 1 || snapshot.owner !== id || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
    !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values) ||
    !Object.entries(snapshot.values).every(([key, v]) => key.startsWith("learning-language:") && typeof v === "string")) {
    throw new Error("帳戶資料格式或歸屬異常，已保留原資料並停止寫入。");
  }
  return snapshot;
}
function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open("learning-language-atomic", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("accounts");
    request.onsuccess = () => {
      if (failed) { request.result.close(); return; }
      databaseConnection = request.result;
      databaseConnection.onversionchange = () => {
        databaseConnection?.close(); databaseConnection = null; databasePromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { failed = true; reject(new Error("另一個舊分頁阻擋資料更新，請關閉後重試。")); };
  }).catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}
async function readDurableSnapshot(id: string | null): Promise<AccountSnapshot | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("accounts", "readonly");
    const request = tx.objectStore("accounts").get(accountKey(id));
    request.onsuccess = () => {
      try { resolve(request.result === undefined ? undefined : validateSnapshot(request.result, id)); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
  });
}
/** Refresh read-only screens after another tab commits the authoritative snapshot. */
export async function refreshAccountCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const id = owner, epoch = generation;
  const durable = await readDurableSnapshot(id);
  if (owner !== id || generation !== epoch || !durable) return;
  durableSnapshots.set(accountKey(id), durable);
  notifyDataChanged();
}
/** Commit the currently staged snapshot before a remote request that depends on its journal. */
export async function flushAccountSnapshot(): Promise<void> {
  if (!transaction) return;
  if (lockOwner !== owner || lockGeneration !== generation) throw new Error("帳戶已切換，舊請求不能回寫。");
  const snapshot = structuredClone(transaction);
  snapshot.revision += 1;
  if (typeof indexedDB === "undefined") {
    if (readAccountSnapshot(snapshot.owner, false).revision !== transaction.revision) throw new Error("資料已被其他寫入者更新，請重試。");
    window.localStorage.setItem(accountKey(snapshot.owner), JSON.stringify(snapshot));
    transaction = structuredClone(snapshot);
    return;
  }
  const database = await openDatabase();
  if (lockOwner !== owner || lockGeneration !== generation) throw new Error("帳戶已切換，舊請求不能回寫。");
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("accounts", "readwrite");
    writingTransaction = tx;
    tx.oncomplete = () => { writingTransaction = null; resolve(); };
    tx.onabort = tx.onerror = () => { writingTransaction = null; reject(tx.error ?? new Error("原子保存已取消，請重試。")); };
    try { tx.objectStore("accounts").put(snapshot, accountKey(snapshot.owner)); } catch (error) { tx.abort(); reject(error); }
  });
  durableSnapshots.set(accountKey(snapshot.owner), snapshot);
  transaction = structuredClone(snapshot);
  try { changesChannel?.postMessage({ owner: snapshot.owner, revision: snapshot.revision }); } catch { /* Commit succeeded; notification is best effort. */ }
  // IndexedDB is authoritative; a failed compatibility mirror cannot lose committed data.
  try { window.localStorage.setItem(accountKey(snapshot.owner), JSON.stringify(snapshot)); } catch { /* Retain prior mirror as recovery copy. */ }
}
export const accountKey = (id: string | null = owner) => `learning-language:account:v1:${id === null ? "guest" : encodeURIComponent(id)}`;
export const getAccountOwner = () => owner;
export const getAccountGeneration = () => generation;
export const hasDurableAccountCache = () => durableSnapshots.has(accountKey()) || transaction?.owner === owner;
export function setAccountOwner(id: string | null): void {
  if (owner === id) return;
  writingTransaction?.abort();
  owner = id; generation += 1; notifyDataChanged();
}
export function subscribeDataChanged(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function notifyDataChanged(): void {
  // Defer until repository commit has updated its in-memory snapshot.
  queueMicrotask(() => { for (const listener of listeners) listener(); });
}
export function invalidateAccountRequests(): void { writingTransaction?.abort(); generation += 1; notifyDataChanged(); }
export function replaceAccountValues(values: Record<string, string>): void {
  atomicAccountWrite(() => { transaction!.values = structuredClone(values); });
}
export function isSyncPaused(): boolean { return typeof window !== "undefined" && accountStorage().getItem("learning-language:sync-paused") === "true"; }
export function readAccountSnapshot(id: string | null = owner, includeStaged = true): AccountSnapshot {
  if (includeStaged && transaction?.owner === id) return structuredClone(transaction);
  const cached = durableSnapshots.get(accountKey(id));
  if (cached) return structuredClone(cached);
  const storage = window.localStorage;
  const raw = storage.getItem(accountKey(id));
  if (raw !== null) {
    return validateSnapshot(JSON.parse(raw), id);
  }
  const values: Record<string, string> = {};
  // No owner can be inferred from old files. Only the guest workspace can read them.
  if (id === null) for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith("learning-language:") && !key.startsWith("learning-language:account:")) {
      const value = storage.getItem(key); if (value !== null) values[key] = value;
    }
  }
  return { format: 1, owner: id, revision: 0, values };
}
export function atomicAccountWrite<T>(action: () => T): T {
  if (typeof indexedDB !== "undefined" && !transaction) throw new Error("瀏覽器寫入必須透過 mutateRepository／withDataLock 原子交易。");
  if (lockHeld && (lockOwner !== owner || lockGeneration !== generation)) throw new Error("舊帳戶請求已失效，未回寫資料。");
  if (transaction) return action();
  const id = owner, epoch = generation;
  const before = readAccountSnapshot();
  transaction = structuredClone(before);
  try {
    const result = action();
    if (id !== owner || epoch !== generation || readAccountSnapshot(id, false).revision !== before.revision) {
      throw new Error("資料或帳戶已更新，請重新載入後再試。");
    }
    transaction.revision += 1;
    window.localStorage.setItem(accountKey(id), JSON.stringify(transaction));
    notifyDataChanged();
    return result;
  } finally { transaction = null; }
}
export function accountStorage(): Storage {
  return {
    get length() { return Object.keys((transaction?.owner === owner ? transaction : readAccountSnapshot()).values).length; },
    key(index) { return Object.keys((transaction?.owner === owner ? transaction : readAccountSnapshot()).values)[index] ?? null; },
    getItem(key) { return (transaction?.owner === owner ? transaction : readAccountSnapshot()).values[key] ?? null; },
    setItem(key, value) { atomicAccountWrite(() => { transaction!.values[key] = String(value); }); },
    removeItem(key) { atomicAccountWrite(() => { delete transaction!.values[key]; }); },
    clear() { throw new Error("不可清空帳戶資料"); },
  };
}
/** All browser mutations and sync drains share a cross-tab Web Lock. */
let runtimeChain: Promise<unknown> = Promise.resolve();
export async function withDataLock<T>(action: () => T | Promise<T>): Promise<T> {
  const id = owner, epoch = generation;
  const run = async () => {
    if (owner !== id || generation !== epoch) throw new Error("帳戶已切換，請重試。");
    lockHeld = true; lockOwner = id; lockGeneration = epoch;
    const indexed = typeof indexedDB !== "undefined";
    try {
      if (indexed) {
        const durable = await readDurableSnapshot(id);
        if (owner !== id || generation !== epoch) throw new Error("帳戶已切換，舊請求不能回寫。");
        if (durable) durableSnapshots.set(accountKey(id), durable);
      }
      if (typeof window !== "undefined") transaction = structuredClone(readAccountSnapshot(id));
      const result = await action();
      if (owner !== id || generation !== epoch) throw new Error("帳戶已切換，舊請求不能回寫。");
      if (transaction) { await flushAccountSnapshot(); notifyDataChanged(); }
      return result;
    } finally { transaction = null; lockHeld = false; }
  };
  const acquire = async (): Promise<T> => {
  if (typeof navigator !== "undefined" && navigator.locks) return await navigator.locks.request(accountKey(id), run);
  // Node tests do not have browser tabs. Unsupported browsers fail closed for async writes.
  if (typeof navigator !== "undefined" && !navigator.userAgent?.includes("Node.js")) {
    throw new Error("此瀏覽器不支援安全的跨分頁寫入，請使用新版瀏覽器。");
  }
  return run();
  };
  const work = runtimeChain.then(acquire, acquire);
  runtimeChain = work.then(() => undefined, () => undefined);
  return work;
}
export function claimGuestData(): void {
  if (!owner) throw new Error("請先登入要接收資料的帳戶。");
  const guest = readAccountSnapshot(null);
  const current = readAccountSnapshot();
  const currentStore = JSON.parse(current.values["learning-language:store"] ?? "{}");
  if (["items", "scheduleStates", "reviewAttempts", "studySessions"].some(key => currentStore[key]?.length)) {
    throw new Error("此帳戶已有資料，目前不支援合併認領；請保留兩份備份，不能跨帳戶還原或覆蓋既有進度。");
  }
  const oldPending = JSON.parse(guest.values["learning-language:sync-outbox"] ?? "[]") as { payload?: { user_id?: string } }[];
  if (!Array.isArray(oldPending) || oldPending.some(entry => entry.payload?.user_id && entry.payload.user_id !== owner)) {
    throw new Error("舊資料含未確認歸屬的待送紀錄，請保留備份並核對原帳戶。");
  }
  atomicAccountWrite(() => {
    for (const [key,value] of Object.entries(guest.values)) {
      if (key === "learning-language:store" || key === "learning-language:store:revision" || key === "learning-language:sync-outbox" || key.startsWith("learning-language:study-preferences") || ((key.startsWith("learning-language:sync-alias") || key.startsWith("learning-language:sync-rebase-journal")) && key.endsWith(`:${owner}`))) transaction!.values[key] = value;
    }
    transaction!.values["learning-language:explicitly-claimed"] = "true";
  });
}
// Notify other tabs even when the compatibility localStorage mirror is full.
const changesChannel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("learning-language-commits") : null;
changesChannel?.addEventListener("message", event => {
  if (event.data?.owner === owner) void refreshAccountCache().catch(() => undefined);
});
export function resetAccountStorageForTests(): void { databaseConnection?.close(); databaseConnection = null; owner = null; generation += 1; transaction = null; lockHeld = false; runtimeChain = Promise.resolve(); durableSnapshots.clear(); databasePromise = null; }

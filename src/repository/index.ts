import { getAccountOwner, setAccountOwner, subscribeDataChanged, withDataLock, notifyDataChanged, refreshAccountCache, hasDurableAccountCache } from "./accountStorage";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { MemoryLearningRepository } from "./memoryRepository";
import { SyncingLearningRepository } from "./syncingRepository";
import { configureSyncEngine, pullAndMergeRemoteData } from "./sync/syncEngine";
import type { LearningRepository } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type {
  LearningRepository,
  LanguageFilter,
  StudySessionFilter,
  RecordGradedAttemptInput,
  RecordGradedAttemptResult,
  MarkAttemptCorrectInput,
  RepositoryDurability,
} from "./types";
export { MemoryLearningRepository } from "./memoryRepository";
export { LocalStorageLearningRepository } from "./localStorageRepository";
export { SyncingLearningRepository } from "./syncingRepository";
export { PersistenceFailedError, describePersistenceError } from "./errors";
export { STORAGE_KEY, SCHEMA_VERSION } from "./schema";

let singleton: LearningRepository | null = null;
let resolveAuthInitialization!: () => void;
const authInitialization = new Promise<void>(resolve => { resolveAuthInitialization = resolve; });
let accountInitialization: Promise<void> = Promise.resolve();
/** Auth bootstrap calls this after choosing the account; no guest writes before that decision. */
export function markRepositoryAuthInitialized(): void { resolveAuthInitialization(); }
export async function waitForRepositoryInitialization(): Promise<void> {
  await authInitialization;
  await accountInitialization;
}

function localStorageIsUsable(): boolean {
  if (hasDurableAccountCache()) return true;
  try {
    const testKey = "__learning_language_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取得單例 repository。伺服器端（SSR）或 localStorage 不可用時，
 * 自動退回純記憶體實作，讓頁面至少能跑，不會整個崩潰。
 *
 * R4：退回記憶體模式時，除了 console.warn，也要讓 UI 能透過
 * `getRepository().durability === "volatile"` 主動顯示警告，不能只寫 console。
 */
export function getRepository(): LearningRepository {
  if (singleton) return singleton;

  if (typeof window === "undefined") {
    singleton = new MemoryLearningRepository();
    return singleton;
  }

  if (localStorageIsUsable()) {
    singleton = new LocalStorageLearningRepository();
  } else {
    console.warn("[learning-language] 這個瀏覽器環境無法使用 localStorage，改用記憶體暫存（重新整理將遺失資料）");
    singleton = new MemoryLearningRepository();
  }
  if (currentCloudSyncUserId && singleton instanceof LocalStorageLearningRepository) singleton = new SyncingLearningRepository(singleton, currentCloudSyncUserId);
  return singleton;
}

/** 只給測試使用：重置模組層級單例，避免測試之間互相汙染。 */
export function __resetRepositorySingletonForTests(): void {
  singleton = null;
  currentCloudSyncUserId = null;
  cloudSyncEpoch += 1;
  lastCloudOptions = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  if (revisionTimer) clearInterval(revisionTimer);
}

// ---------------------------------------------------------------------------
// 雲端同步（2026-09-16 雲端化新增）
// ---------------------------------------------------------------------------

export interface CloudSyncOptions {
  supabase: SupabaseClient;
  userId: string;
}

let currentCloudSyncUserId: string | null = null;
/** 讓「設定已經換掉之後才 settle 的 pull-merge 結果」不會覆蓋掉更新的 singleton。 */
let cloudSyncEpoch = 0;

/** 跟 getRepository() 預設（登出）路徑用同一套規則，確保兩者的 fallback 行為一致。 */
function createLocalOnlyRepository(): LearningRepository {
  if (typeof window === "undefined") {
    return new MemoryLearningRepository();
  }
  if (localStorageIsUsable()) {
    return new LocalStorageLearningRepository();
  }
  console.warn("[learning-language] 這個瀏覽器環境無法使用 localStorage，改用記憶體暫存（重新整理將遺失資料）");
  return new MemoryLearningRepository();
}

/**
 * 拉取雲端資料併回本機，成功後換一份會讀到合併結果的 singleton（見 syncEngine.ts 開頭註解）。
 * 登入當下與「背景 drain 建立別名或重放排程」後都走這條，兩者行為一致；`epoch` 讓已被換掉的設定
 * （登出／換人）之後才 settle 的結果不會覆蓋較新的 singleton。
 */
function refreshFromRemote(options: CloudSyncOptions, epoch: number): Promise<void> {
  return pullAndMergeRemoteData(options.supabase, options.userId, () => epoch === cloudSyncEpoch && options.userId === currentCloudSyncUserId)
    .then(() => {
      if (epoch !== cloudSyncEpoch) return;
      if (typeof window === "undefined" || !localStorageIsUsable()) return;
      // 合併結果已經寫回 localStorage；重新建一份會讀到最新內容的實例並換掉 singleton 的
      // inner，之後的 getRepository() 呼叫才看得到合併後的資料。
      singleton = new SyncingLearningRepository(new LocalStorageLearningRepository(), options.userId);
    })
    .catch((error) => {
      if (epoch !== cloudSyncEpoch) return;
      console.warn("[learning-language] 雲端下載失敗，稍後重試", error);
      refreshTimer = setTimeout(() => { if (epoch === cloudSyncEpoch) refreshFromRemote(options, epoch); }, 15000);
    });
}

function engineConfig(options: CloudSyncOptions) {
  return {
    ...options,
    onAliasCommitted: () => refreshFromRemote(options, cloudSyncEpoch),
  };
}

/**
 * auth 狀態解析後（由 `AuthSyncBootstrapper` 呼叫）：
 * - `null`（登出／尚未登入）：停用背景同步。只有「先前確實是同步模式」才會把 singleton
 *   換回純本機——app 一開始就還沒登入時，`singleton` 通常還是 `null`（尚未被任何頁面的
 *   `getRepository()` 呼叫建立過），這裡不主動搶著建立，避免跟頁面自己的 `useEffect`
 *   互相搶第一次建立、多做一次不必要的 localStorage 讀取。
 * - `{ supabase, userId }`：同一個使用者重複呼叫（例如 Supabase 的 `TOKEN_REFRESHED`
 *   事件，同一次登入 session 可能每隔一段時間就觸發一次）只更新 syncEngine 持有的
 *   client／立即 kick 一次，不重新包裝 singleton、不重新 pull-merge——避免每次 token
 *   刷新都白白重拉一次遠端資料。真正的使用者變更（首次登入、或換成不同使用者）才會：
 *   1. 同步把 singleton 換成 `SyncingLearningRepository`（盡量沿用既有的
 *      `LocalStorageLearningRepository` 實例，不重新讀一次 localStorage）。
 *   2. 背景（非阻塞）觸發 pull-merge；成功寫回 localStorage 後，重新建立一份會讀到
 *      合併後資料的 `LocalStorageLearningRepository` 並換掉 singleton 的 inner。
 */
export function configureCloudSync(options: CloudSyncOptions | null): void {
  lastCloudOptions = options;
  if (refreshTimer) clearTimeout(refreshTimer);
  if (revisionTimer) clearInterval(revisionTimer);
  revisionTimer = null;
  if (!options) {
    cloudSyncEpoch += 1;
    configureSyncEngine(null);
    setAccountOwner(null);
    singleton = null;
    currentCloudSyncUserId = null;
    accountInitialization = refreshAccountCache().catch(() => undefined);
    return;
  }

  if (options.userId === currentCloudSyncUserId && singleton instanceof SyncingLearningRepository) {
    // 同一個使用者、已經是同步模式：只刷新 syncEngine 持有的 client 參照＋踢一次背景
    // drain（涵蓋 token 剛刷新、outbox 剛好有殘留的情況），不重新包裝、不重新 pull-merge。
    configureSyncEngine(engineConfig(options));
    watchRemoteRevision(options, cloudSyncEpoch);
    return;
  }
  setAccountOwner(options.userId);
  singleton = null;
  currentCloudSyncUserId = options.userId;

  cloudSyncEpoch += 1;
  const epoch = cloudSyncEpoch;

  configureSyncEngine(engineConfig(options));

  const reuseExistingInner = null;
  const inner =
    reuseExistingInner ?? (typeof window !== "undefined" && localStorageIsUsable() ? new LocalStorageLearningRepository() : null);

  singleton = inner ? new SyncingLearningRepository(inner, options.userId) : new MemoryLearningRepository();

  accountInitialization = refreshAccountCache().then(() => refreshFromRemote(options, epoch)).catch(() => undefined);
  watchRemoteRevision(options, epoch);
}

/** A visible tab notices other devices without rewriting the active answer form. */
function watchRemoteRevision(options: CloudSyncOptions, epoch: number): void {
  if (typeof document === "undefined") return;
  let revision: string | undefined;
  let checking = false;
  revisionTimer = setInterval(() => {
    if (document.visibilityState !== "visible" || checking || epoch !== cloudSyncEpoch) return;
    checking = true;
    void Promise.resolve(options.supabase.rpc("get_learning_revision")).then(({ data, error }) => {
      if (error || epoch !== cloudSyncEpoch || typeof data !== "string" || !/^\d+$/.test(data)) return;
      if (revision !== data) { revision = data; refreshFromRemote(options, epoch); }
    }).catch(() => undefined).finally(() => { checking = false; });
  }, 30_000);
}

/** Always acquire the account Web Lock before browser writes; reload after other tabs. */
export async function mutateRepository<T>(action: (repository: LearningRepository) => T): Promise<T> {
  return withDataLock(() => {
    singleton = getAccountOwner() ? new SyncingLearningRepository(new LocalStorageLearningRepository(), getAccountOwner()!) : createLocalOnlyRepository();
    return action(singleton);
  }).catch(error => { singleton = null; throw error; });
}
export function refreshCloudData(): void {
  if (currentCloudSyncUserId && lastCloudOptions) refreshFromRemote(lastCloudOptions, cloudSyncEpoch);
}
let lastCloudOptions: CloudSyncOptions | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let revisionTimer: ReturnType<typeof setInterval> | null = null;
subscribeDataChanged(() => { singleton = null; });
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", () => { singleton = null; void refreshAccountCache().catch(() => notifyDataChanged()); });
  void refreshAccountCache().catch(() => undefined);
  window.addEventListener("focus", refreshCloudData);
  window.addEventListener("online", refreshCloudData);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshCloudData();
  });
}
export { subscribeDataChanged };

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

function localStorageIsUsable(): boolean {
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
  return singleton;
}

/** 只給測試使用：重置模組層級單例，避免測試之間互相汙染。 */
export function __resetRepositorySingletonForTests(): void {
  singleton = null;
  currentCloudSyncUserId = null;
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
  if (!options) {
    configureSyncEngine(null);
    if (singleton instanceof SyncingLearningRepository) {
      singleton = createLocalOnlyRepository();
    }
    currentCloudSyncUserId = null;
    return;
  }

  if (options.userId === currentCloudSyncUserId && singleton instanceof SyncingLearningRepository) {
    // 同一個使用者、已經是同步模式：只刷新 syncEngine 持有的 client 參照＋踢一次背景
    // drain（涵蓋 token 剛刷新、outbox 剛好有殘留的情況），不重新包裝、不重新 pull-merge。
    configureSyncEngine(options);
    return;
  }
  currentCloudSyncUserId = options.userId;

  cloudSyncEpoch += 1;
  const epoch = cloudSyncEpoch;

  configureSyncEngine(options);

  const reuseExistingInner = singleton instanceof LocalStorageLearningRepository ? singleton : null;
  const inner =
    reuseExistingInner ?? (typeof window !== "undefined" && localStorageIsUsable() ? new LocalStorageLearningRepository() : null);

  singleton = inner ? new SyncingLearningRepository(inner, options.userId) : new MemoryLearningRepository();

  void pullAndMergeRemoteData(options.supabase, options.userId)
    .then(() => {
      if (epoch !== cloudSyncEpoch) return; // 設定已經換掉（例如登出／換人）：這次結果不再適用
      if (typeof window === "undefined" || !localStorageIsUsable()) return;
      // 合併結果已經寫回 localStorage；重新建一份會讀到最新內容的實例並換掉 singleton 的
      // inner，之後的 getRepository() 呼叫才看得到合併後的資料（見 syncEngine.ts 開頭註解）。
      singleton = new SyncingLearningRepository(new LocalStorageLearningRepository(), options.userId);
    })
    .catch((error) => {
      if (epoch !== cloudSyncEpoch) return;
      console.warn("[learning-language] 登入後下載雲端資料失敗，暫時只使用本機資料，稍後會自動重試同步", error);
    });
}

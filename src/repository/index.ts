import { LocalStorageLearningRepository } from "./localStorageRepository";
import { MemoryLearningRepository } from "./memoryRepository";
import type { LearningRepository } from "./types";

export type {
  LearningRepository,
  LanguageFilter,
  StudySessionFilter,
  RecordGradedAttemptInput,
  RecordGradedAttemptResult,
  RepositoryDurability,
} from "./types";
export { MemoryLearningRepository } from "./memoryRepository";
export { LocalStorageLearningRepository } from "./localStorageRepository";
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
}

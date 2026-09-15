import { BaseLearningRepository } from "./baseRepository";
import { createEmptyStore, type PersistedStore } from "./schema";
import type { RepositoryDurability } from "./types";

/**
 * 純記憶體實作：不寫入任何裝置儲存空間，重新整理就會遺失。
 * 用途：
 * - 單元測試（不需要真的碰 localStorage）。
 * - SSR（伺服器端沒有 window/localStorage）。
 * - 瀏覽器 localStorage 被封鎖（例如私密瀏覽模式部分設定）時的安全後備，
 *   讓 App 至少還能跑，而不是直接壞掉。
 *
 * `durability = "volatile"`：R4 要求 UI 能辨識目前是不是這種「重新整理會遺失資料」的
 * 模式，並明確警告使用者，不能只在 console 印一行。
 */
export class MemoryLearningRepository extends BaseLearningRepository {
  readonly durability: RepositoryDurability = "volatile";

  constructor(initialStore: PersistedStore = createEmptyStore()) {
    super(initialStore);
  }

  protected persistSnapshot(): void {
    // 有意不做事：純記憶體，沒有持久化目的地，也永遠不會寫入失敗。
  }
}

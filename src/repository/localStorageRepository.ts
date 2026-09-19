import { BaseLearningRepository } from "./baseRepository";
import { PersistenceFailedError } from "./errors";
import { buildSeedItems } from "./seed";
import {
  STORAGE_KEY,
  createEmptyStore,
  readStoreRevision,
  sanitizeStore,
  writePersistedStore,
  type PersistedStore,
} from "./schema";
import type { RepositoryDurability } from "./types";

const CORRUPT_BACKUP_KEY = `${STORAGE_KEY}:corrupt-backup`;

function isQuotaExceededError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    // QuotaExceededError 的 name 在各瀏覽器一致；舊版 code 22（Firefox 早期用 1014）。
    return error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014;
  }
  return false;
}

/** 備份原始壞資料，供事後除錯；備份本身失敗（例如容量已滿）不能讓啟動流程掛掉。 */
function tryBackupCorruptRaw(raw: string): void {
  try {
    window.localStorage.setItem(CORRUPT_BACKUP_KEY, raw);
  } catch (error) {
    console.warn("[learning-language] 備份異常本機資料失敗（不影響本次啟動）", error);
  }
}

/**
 * 以 window.localStorage 持久化的實作。
 *
 * 讀取規則：
 * - 完全沒有存檔（首次啟動）→ 建立空 store 並塞入範例種子資料。
 * - 有存檔但格式合法 → 直接使用（sanitizeStore 內部仍會逐筆過濾＋跨紀錄關聯清理）。
 * - 有存檔但格式不合法（JSON 壞掉、schemaVersion 對不上、個別紀錄壞掉）→ 安全回退，
 *   不重新塞種子資料（避免和使用者已清除的狀態衝突）；JSON 壞掉或 sanitize 判定需要
 *   fallback 時，原始內容都會備份到 `${STORAGE_KEY}:corrupt-backup`，備份本身失敗
 *   也不會讓這次啟動白屏。
 *
 * 寫入規則（R4）：
 * - `persistSnapshot` 失敗會丟出 `PersistenceFailedError`，呼叫端（BaseLearningRepository
 *   的 `commit`）保證這種情況下 `this.store` 不會被換成寫入失敗的版本，記憶體與持久化
 *   狀態不會分歧；再由更上層（頁面）決定怎麼呈現錯誤給使用者。
 */
export class LocalStorageLearningRepository extends BaseLearningRepository {
  readonly durability: RepositoryDurability = "persistent";

  /** 建構當下（也就是最後一次真的讀取 localStorage 那一刻）的 store revision。 */
  private lastKnownRevision: number;

  constructor() {
    super(LocalStorageLearningRepository.loadInitialStore());
    this.lastKnownRevision = readStoreRevision();
  }

  protected detectExternalChange(): boolean {
    return readStoreRevision() !== this.lastKnownRevision;
  }

  private static loadInitialStore(): PersistedStore {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.warn("[learning-language] 讀取本機資料失敗，改用空白狀態", error);
      return createEmptyStore();
    }

    if (raw === null) {
      const store = createEmptyStore();
      store.items = buildSeedItems(new Date());
      return store;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn("[learning-language] 本機資料不是合法 JSON，已安全回退為空白狀態", error);
      tryBackupCorruptRaw(raw);
      return createEmptyStore();
    }

    const { store, usedFallback, droppedCounts, missingArrays } = sanitizeStore(parsed);
    if (usedFallback) {
      console.warn("[learning-language] 偵測到本機資料格式異常（舊版或非法格式），已安全回退", {
        droppedCounts,
        missingArrays,
      });
      tryBackupCorruptRaw(raw);
    }
    return store;
  }

  protected persistSnapshot(nextStore: PersistedStore): void {
    try {
      // 透過 schema.ts 的 `writePersistedStore` 寫入（JSON.stringify 失敗會在這裡拋出），
      // 讓「主要 store 寫入」與「revision bump」永遠是同一個函式負責，不會有兩處各自
      // 序列化／各自決定要不要 bump revision 而不小心不一致。
      writePersistedStore(nextStore);
    } catch (error) {
      if (isQuotaExceededError(error)) {
        throw new PersistenceFailedError("quota_exceeded", "本機儲存空間已滿，這次的變更沒有保存");
      }
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new PersistenceFailedError("serialize_failed", `本機資料序列化失敗：${String(error)}`);
      }
      throw new PersistenceFailedError("unknown", `本機資料寫入失敗：${String(error)}`);
    }
    // 寫入（含 revision bump）確定成功之後才更新自己記住的 revision，這樣「這次 commit
    // 是我自己做的」不會被下一次 detectExternalChange 誤判成外部變更。
    this.lastKnownRevision = readStoreRevision();
  }
}

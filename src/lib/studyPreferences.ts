/**
 * 2026-09-16 雲端化：新增「每日新字上限」偏好，並讓兩個偏好在成功保存到本機之後都
 * 呼叫 `notifyPreferencesChanged` 推進 outbox（`upsert_preferences`）。這個檔案因此依賴
 * `repository/sync/syncEngine`，方向是單向的（syncEngine／outbox 不會反過來依賴這裡），
 * 不會造成循環 import；未設定雲端同步（未登入）時 `notifyPreferencesChanged` 是純
 * no-op，本機行為跟雲端化之前完全一樣。
 */
import { notifyPreferencesChanged } from "@/repository/sync/syncEngine";

export const STUDY_QUESTION_COUNT_OPTIONS = [5, 10, 15, 20] as const;
export type StudyQuestionCount = (typeof STUDY_QUESTION_COUNT_OPTIONS)[number];
export const DEFAULT_STUDY_QUESTION_COUNT: StudyQuestionCount = 10;

/** DB 端 check constraint 是 `> 0 and <= 50` 的範圍，這裡選幾個常用值當預設選項即可，不需要自由數字輸入。 */
export const DAILY_NEW_ITEM_CAP_OPTIONS = [5, 10, 15, 20, 30] as const;
export type DailyNewItemCap = (typeof DAILY_NEW_ITEM_CAP_OPTIONS)[number];
export const DEFAULT_DAILY_NEW_ITEM_CAP: DailyNewItemCap = 10;

const STORAGE_KEY = "learning-language:study-preferences:v1";
const NEW_ITEM_CAP_STORAGE_KEY = "learning-language:study-preferences:new-item-cap:v1";

function isStudyQuestionCount(value: number): value is StudyQuestionCount {
  return STUDY_QUESTION_COUNT_OPTIONS.includes(value as StudyQuestionCount);
}

function isDailyNewItemCap(value: number): value is DailyNewItemCap {
  return DAILY_NEW_ITEM_CAP_OPTIONS.includes(value as DailyNewItemCap);
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStudyQuestionCount(storage: Storage | undefined = browserStorage()): StudyQuestionCount {
  if (!storage) return DEFAULT_STUDY_QUESTION_COUNT;
  try {
    const value = Number(storage.getItem(STORAGE_KEY));
    return isStudyQuestionCount(value) ? value : DEFAULT_STUDY_QUESTION_COUNT;
  } catch {
    return DEFAULT_STUDY_QUESTION_COUNT;
  }
}

export function readDailyNewItemCap(storage: Storage | undefined = browserStorage()): DailyNewItemCap {
  if (!storage) return DEFAULT_DAILY_NEW_ITEM_CAP;
  try {
    const value = Number(storage.getItem(NEW_ITEM_CAP_STORAGE_KEY));
    return isDailyNewItemCap(value) ? value : DEFAULT_DAILY_NEW_ITEM_CAP;
  } catch {
    return DEFAULT_DAILY_NEW_ITEM_CAP;
  }
}

/** 兩個偏好一起讀出，供 migration／同步使用同一個形狀（跟 `user_preferences` 資料表對應）。 */
export function readSyncablePreferences(
  storage: Storage | undefined = browserStorage()
): { dailyQuestionCount: StudyQuestionCount; dailyNewItemCap: DailyNewItemCap } {
  return {
    dailyQuestionCount: readStudyQuestionCount(storage),
    dailyNewItemCap: readDailyNewItemCap(storage),
  };
}

/**
 * 把雲端已存在的偏好寫回本機，不觸發新的 outbox。初始 migration 用它避免新裝置的預設值
 * 反過來覆蓋帳戶原本的設定。兩個舊版 storage key 以 best-effort rollback 維持一起成功。
 */
export function applySyncedPreferences(
  preferences: { dailyQuestionCount: StudyQuestionCount; dailyNewItemCap: DailyNewItemCap },
  storage: Storage | undefined = browserStorage()
): void {
  if (!isStudyQuestionCount(preferences.dailyQuestionCount)) throw new Error("雲端每次學習題數不合法");
  if (!isDailyNewItemCap(preferences.dailyNewItemCap)) throw new Error("雲端每日新字上限不合法");
  if (!storage) throw new Error("這個瀏覽器目前無法保存設定");

  const previousQuestionCount = storage.getItem(STORAGE_KEY);
  const previousNewItemCap = storage.getItem(NEW_ITEM_CAP_STORAGE_KEY);
  try {
    storage.setItem(STORAGE_KEY, String(preferences.dailyQuestionCount));
    storage.setItem(NEW_ITEM_CAP_STORAGE_KEY, String(preferences.dailyNewItemCap));
  } catch (error) {
    try {
      if (previousQuestionCount === null) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, previousQuestionCount);
      if (previousNewItemCap === null) storage.removeItem(NEW_ITEM_CAP_STORAGE_KEY);
      else storage.setItem(NEW_ITEM_CAP_STORAGE_KEY, previousNewItemCap);
    } catch {
      // 原始錯誤仍要往上丟；rollback 失敗不能把「同步偏好已成功」偽裝出來。
    }
    throw error;
  }
}

export function saveStudyQuestionCount(
  count: StudyQuestionCount,
  storage: Storage | undefined = browserStorage()
): void {
  if (!isStudyQuestionCount(count)) throw new Error(`不支援的每次學習題數：${count}`);
  if (!storage) throw new Error("這個瀏覽器目前無法保存設定");
  storage.setItem(STORAGE_KEY, String(count));
  notifyPreferencesChanged({ dailyQuestionCount: count, dailyNewItemCap: readDailyNewItemCap(storage) });
}

export function saveDailyNewItemCap(
  cap: DailyNewItemCap,
  storage: Storage | undefined = browserStorage()
): void {
  if (!isDailyNewItemCap(cap)) throw new Error(`不支援的每日新字上限：${cap}`);
  if (!storage) throw new Error("這個瀏覽器目前無法保存設定");
  storage.setItem(NEW_ITEM_CAP_STORAGE_KEY, String(cap));
  notifyPreferencesChanged({ dailyQuestionCount: readStudyQuestionCount(storage), dailyNewItemCap: cap });
}

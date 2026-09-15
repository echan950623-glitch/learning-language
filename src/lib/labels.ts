import type { ItemSource, ItemStatus } from "../domain/types";

export const STATUS_LABELS: Record<ItemStatus, string> = {
  new: "已接觸",
  learning: "學習中",
  mastered: "已掌握",
  struggling: "需要加強",
};

export const STATUS_TONE: Record<ItemStatus, "neutral" | "success" | "warning" | "danger"> = {
  new: "neutral",
  learning: "neutral",
  mastered: "success",
  struggling: "danger",
};

export const SOURCE_LABELS: Record<ItemSource, string> = {
  ai: "AI 教練（下一階段）",
  textbook: "課文",
  teacher: "老師",
  song: "歌曲",
  manual: "手動輸入",
};

/** 使用者新增內容表單只開放這四個來源；ai 保留給之後串接 AI 教練時的自動建議使用 */
export const USER_SELECTABLE_SOURCES: ItemSource[] = ["textbook", "teacher", "song", "manual"];

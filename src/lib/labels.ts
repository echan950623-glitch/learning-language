import type { AbilityKind, ItemSource, ItemStatus, LearningItem } from "../domain/types";
import { containsKanji } from "../domain/text";

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

/** 平假名讀音練習固定用這個名稱，不受項目內容影響（只有漢字／單字才會需要獨立的 reading 能力）。 */
const READING_PRACTICE_LABEL = "平假名練習";

/**
 * 給使用者看的能力名稱，不出現 recall／reading 這種內部英文代稱：
 * - reading 固定顯示「平假名練習」。
 * - recall 依項目內容而定：答案含漢字顯示「漢字練習」，純假名詞彙顯示「單字練習」
 *   （同一種 recall 能力，pure-kana 項目沒有漢字可以練，稱「漢字練習」會誤導）。
 */
export function abilityDisplayLabel(ability: AbilityKind, item: Pick<LearningItem, "answer">): string {
  if (ability === "reading") return READING_PRACTICE_LABEL;
  return containsKanji(item.answer) ? "漢字練習" : "單字練習";
}

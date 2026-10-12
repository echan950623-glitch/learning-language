import type { AbilityKind, ItemSource, ItemStatus, LearningItem, StudyMode } from "../domain/types";
import { CAPABILITY_LABELS, PRACTICE_KIND_LABELS } from "../domain/learningPractice";

export const STATUS_LABELS: Record<ItemStatus, string> = {
  new: "收件匣",
  learning: "學習中",
  mastered: "穩定複習",
  struggling: "需要加強",
};
export const STUDY_MODE_LABELS: Record<StudyMode, string> = { today: "今日學習", wrong: "錯題複習", full: "總複習", random: "隨機練習" };

export const STATUS_TONE: Record<ItemStatus, "neutral" | "success" | "warning" | "danger"> = {
  new: "neutral",
  learning: "neutral",
  mastered: "success",
  struggling: "danger",
};

export const SOURCE_LABELS: Record<ItemSource, string> = {
  ai: "GPT／AI 教練",
  textbook: "課文",
  teacher: "老師",
  song: "歌曲",
  manual: "手動輸入",
};

/** 使用者新增內容表單只開放這四個來源；ai 保留給之後串接 AI 教練時的自動建議使用 */
export const USER_SELECTABLE_SOURCES: ItemSource[] = ["textbook", "teacher", "song", "manual"];

/** 平假名讀音練習固定用這個名稱，不受項目內容影響（只有漢字／單字才會需要獨立的 reading 能力）。 */
const READING_PRACTICE_LABEL = "讀音回想";

/**
 * 給使用者看的能力名稱，不出現 recall／reading 這種內部英文代稱：
 * - reading 固定顯示「平假名練習」。
 * - recall 依項目內容而定：答案含漢字顯示「漢字練習」，純假名詞彙顯示「單字練習」
 *   （同一種 recall 能力，pure-kana 項目沒有漢字可以練，稱「漢字練習」會誤導）。
 */
export function abilityDisplayLabel(ability: AbilityKind, item: Pick<LearningItem, "answer" | "answerFormat" | "practice">): string {
  if (ability === "meaning") return "意思理解";
  if (item.practice) return `${PRACTICE_KIND_LABELS[item.practice.kind]}・${CAPABILITY_LABELS[item.practice.capability]}`;
  if (ability === "reading") return READING_PRACTICE_LABEL;
  return item.answerFormat === "kanji" ? "指定漢字寫法" : "詞彙回想";
}

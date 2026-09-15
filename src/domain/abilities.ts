/**
 * 一個 LearningItem 需要練習哪些「能力」（recall／reading），集中在這裡判斷，
 * 讓 queue／exercises／srs／repository 都用同一套規則，不會各自各判斷一次而產生分歧。
 */

import type { AbilityKind, LearningItem } from "./types";

/** 是否有「跟答案不同、值得獨立練習」的假名讀音（純假名的字讀音等於答案本身，不需要獨立 reading 能力）。 */
export function hasUsableReading(item: LearningItem): boolean {
  return Boolean(item.reading && item.reading.trim().length > 0 && item.reading !== item.answer);
}

/**
 * 這個項目要達到 mastered，必須練到的能力清單。
 * - recall（中文 → 日文）永遠需要。
 * - reading（漢字／日文 → 假名）只有在有獨立讀音時才需要；純假名的字只需要 recall。
 */
export function requiredAbilities(item: LearningItem): AbilityKind[] {
  return hasUsableReading(item) ? ["recall", "reading"] : ["recall"];
}

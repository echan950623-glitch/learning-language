/**
 * 規則式自動評分：不串 AI／外部 API，同樣輸入永遠得到同樣輸出。
 *
 * 兩種能力比對規則不同：
 * - recall（中文 → 日文）：把使用者輸入與 LearningItem.answer 都做同一套正規化
 *   （trim／NFKC／清除多餘空白）後完整比對，不接受片假名／平假名互轉這種寬容。
 * - reading（漢字／單字 → 假名讀音）：除了同一套正規化，額外把片假名轉成平假名再比對，
 *   讓使用者用片假名輸入平假名讀音也算對；但不做任何羅馬字轉換，所以像 "sensei" 這種
 *   羅馬字輸入永遠不會等於期望的假名答案，自然被拒絕，不需要額外的黑名單邏輯。
 *
 * 空白（含只有空白）輸入永遠判定為 incorrect：正規化後會變成空字串，
 * 不可能等於非空的 expectedAnswer（LearningItem.answer／reading 建立時已保證非空）。
 */

import type { AbilityKind } from "./types";
import { katakanaToHiragana, normalizeForComparison } from "./text";

export interface GradeAttemptInput {
  ability: AbilityKind;
  /** 使用者實際輸入的原始文字，尚未做任何處理 */
  rawInput: string;
  /** 這一題的正確答案（recall 用 item.answer，reading 用 item.reading） */
  expectedAnswer: string;
}

export interface GradeAttemptResult {
  correct: boolean;
  /** 用來比對的正規化後輸入，供 UI 顯示「你的答案」 */
  normalizedInput: string;
  /** 正確答案（原樣，未正規化），供 UI 顯示 */
  expectedAnswer: string;
}

function normalizeForAbility(value: string, ability: AbilityKind): string {
  const normalized = normalizeForComparison(value);
  return ability === "reading" ? katakanaToHiragana(normalized) : normalized;
}

export function gradeAttempt(input: GradeAttemptInput): GradeAttemptResult {
  const normalizedInput = normalizeForAbility(input.rawInput, input.ability);
  const normalizedExpected = normalizeForAbility(input.expectedAnswer, input.ability);

  return {
    correct: normalizedInput.length > 0 && normalizedInput === normalizedExpected,
    normalizedInput,
    expectedAnswer: input.expectedAnswer,
  };
}

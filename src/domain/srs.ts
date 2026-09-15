/**
 * 簡化版 SRS（間隔複習）排程規則。
 *
 * 規則（對應 PRODUCT_SPEC.md 第 3、7 節）套用在「單一能力」上（見 abilities.ts）：
 * 一個 LearningItem 的 recall 與 reading 各自有自己的 streak／lapseCount／到期日，
 * 用同一套規則各自獨立計算，不會互相蓋過。
 *
 * - 新能力第一次答對：1 天後複習（streak 1 → interval 1）。
 * - 連續答對：間隔依序延長為 1、3、7、14、30 天（streak 對應 REVIEW_INTERVALS_DAYS 索引）。
 * - 部分答對：1 天後複習，熟練進度（streak）不增加、也不重設。
 * - 答錯：streak 重設為 0，累計 lapseCount +1，1 天後再複習。
 * - 累計 lapseCount 達 STRUGGLE_LAPSE_THRESHOLD（預設 3）該能力標為 struggling。
 * - streak 達 MASTERY_STREAK（等於 REVIEW_INTERVALS_DAYS 長度，預設 5，
 *   即連續答對到間隔拉到 30 天）該能力標為 mastered，即使之前有過 lapse 也一樣
 *   （只要「現在」連續穩定達標即可，不是一輩子不能答錯）。
 *
 * 一個 LearningItem 的整體狀態（ItemStatus）則是把它「必要能力」（requiredAbilities）
 * 各自的狀態用 combineAbilityStatuses 合併：全部 mastered 才是 mastered，
 * 任何一項 struggling 就整體 struggling，避免「只考 recall 就 mastered」。
 *
 * 這裡全部是純函式：同樣的輸入永遠得到同樣的輸出，方便單元測試與之後替換演算法。
 * 不依賴任何模型／AI 判斷 due date 或題型。
 */

import type { AttemptResult, ItemStatus } from "./types";
import { addDays } from "./time";

export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30] as const;
export const MASTERY_STREAK = REVIEW_INTERVALS_DAYS.length;
export const STRUGGLE_LAPSE_THRESHOLD = 3;

export interface SchedulePosition {
  streak: number;
  lapseCount: number;
}

export interface NextSchedule extends SchedulePosition {
  intervalDays: number;
  /** ISO 時間字串 */
  dueAt: string;
  status: ItemStatus;
}

/** 依目前連續答對次數（streak，answered 後的新值）決定複習間隔天數 */
export function intervalForStreak(streak: number): number {
  if (streak <= 0) return REVIEW_INTERVALS_DAYS[0];
  const index = Math.min(streak - 1, REVIEW_INTERVALS_DAYS.length - 1);
  return REVIEW_INTERVALS_DAYS[index];
}

/**
 * 依單一能力的 streak／lapseCount／是否已作答過推導該能力的狀態。
 * 判斷順序：先看是否達到 mastered 門檻，再看是否達到 struggling 門檻，
 * 都沒有的話只要作答過就是 learning，完全沒作答過才是 new。
 */
export function deriveStatus(
  streak: number,
  lapseCount: number,
  hasBeenReviewed: boolean
): ItemStatus {
  if (streak >= MASTERY_STREAK) return "mastered";
  if (lapseCount >= STRUGGLE_LAPSE_THRESHOLD) return "struggling";
  return hasBeenReviewed ? "learning" : "new";
}

/**
 * 把一個 LearningItem 所有「必要能力」各自的狀態合併成整體 ItemStatus。
 * - 全部都還沒碰過（new）→ 整體 new。
 * - 全部都 mastered → 整體 mastered（漢字項目必須 recall 與 reading 都達標）。
 * - 任何一項 struggling → 整體 struggling（其中一項常答錯就該被標記需要加強）。
 * - 其餘（至少碰過一項，但沒有全部 mastered 也沒有任何一項 struggling）→ learning。
 */
export function combineAbilityStatuses(statuses: ItemStatus[]): ItemStatus {
  if (statuses.length === 0) return "new";
  if (statuses.every((s) => s === "new")) return "new";
  if (statuses.every((s) => s === "mastered")) return "mastered";
  if (statuses.some((s) => s === "struggling")) return "struggling";
  return "learning";
}

/**
 * 計算某次作答結果後，單一能力的下一個排程狀態。
 * @param previous 目前的 streak／lapseCount；這個能力第一次作答（尚無 ScheduleState）傳 null。
 * @param result 這次作答結果。
 * @param now 作答當下時間，用來算 dueAt；由呼叫端傳入以利測試（避免內部偷用 Date.now()）。
 */
export function computeNextSchedule(
  previous: SchedulePosition | null,
  result: AttemptResult,
  now: Date
): NextSchedule {
  const prevStreak = previous?.streak ?? 0;
  const prevLapseCount = previous?.lapseCount ?? 0;

  let streak = prevStreak;
  let lapseCount = prevLapseCount;
  let intervalDays: number;

  switch (result) {
    case "correct": {
      streak = prevStreak + 1;
      intervalDays = intervalForStreak(streak);
      break;
    }
    case "partial": {
      streak = prevStreak; // 熟練進度不增加，但也不重設
      intervalDays = REVIEW_INTERVALS_DAYS[0];
      break;
    }
    case "incorrect": {
      streak = 0; // 重設目前進度
      lapseCount = prevLapseCount + 1;
      intervalDays = REVIEW_INTERVALS_DAYS[0];
      break;
    }
  }

  const dueAt = addDays(now, intervalDays).toISOString();
  const status = deriveStatus(streak, lapseCount, true);

  return { streak, lapseCount, intervalDays, dueAt, status };
}

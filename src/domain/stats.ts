/**
 * 統計計算，全部從實際保存的 items／attempts 推導，不憑印象或假資料。
 */

import type { Language, LearningItem, ReviewAttempt, ScheduleState } from "./types";
import { addDays } from "./time";

export interface StatusCounts {
  total: number;
  new: number;
  learning: number;
  mastered: number;
  struggling: number;
}

export function computeStatusCounts(items: LearningItem[], language: Language): StatusCounts {
  const filtered = items.filter((item) => item.language === language);
  const counts: StatusCounts = { total: filtered.length, new: 0, learning: 0, mastered: 0, struggling: 0 };
  for (const item of filtered) {
    counts[item.status] += 1;
  }
  return counts;
}

export interface AccuracyResult {
  /** 0～100 的整數百分比；sampleSize 為 0 時回傳 0，呼叫端需另外處理「無資料」顯示 */
  accuracyPercent: number;
  sampleSize: number;
}

/** 近 7 日正確率：答對記 1 分、部分答對記 0.5 分、答錯記 0 分，取平均。 */
export function computeSevenDayAccuracy(
  attempts: ReviewAttempt[],
  language: Language,
  now: Date
): AccuracyResult {
  const windowStart = addDays(now, -7).getTime();
  const relevant = attempts.filter(
    (attempt) => attempt.language === language && new Date(attempt.reviewedAt).getTime() >= windowStart
  );

  if (relevant.length === 0) {
    return { accuracyPercent: 0, sampleSize: 0 };
  }

  const score = relevant.reduce((sum, attempt) => {
    if (attempt.result === "correct") return sum + 1;
    if (attempt.result === "partial") return sum + 0.5;
    return sum;
  }, 0);

  return {
    accuracyPercent: Math.round((score / relevant.length) * 100),
    sampleSize: relevant.length,
  };
}

export interface UpcomingReviewOverview {
  /** 明天（含）之前到期的項目數 */
  dueWithinOneDay: number;
  /** 7 天內到期的項目數（含 dueWithinOneDay） */
  dueWithinWeek: number;
}

/** 給今日結算頁用的「下一次到期複習概況」，只看已經有排程狀態的項目。 */
export function computeUpcomingReviewOverview(
  scheduleStates: ScheduleState[],
  language: Language,
  now: Date
): UpcomingReviewOverview {
  const oneDayAhead = addDays(now, 1).getTime();
  const weekAhead = addDays(now, 7).getTime();
  const relevant = scheduleStates.filter((s) => s.language === language);

  let dueWithinOneDay = 0;
  let dueWithinWeek = 0;
  for (const state of relevant) {
    const dueAtMs = new Date(state.dueAt).getTime();
    if (dueAtMs <= oneDayAhead) dueWithinOneDay += 1;
    if (dueAtMs <= weekAhead) dueWithinWeek += 1;
  }

  return { dueWithinOneDay, dueWithinWeek };
}

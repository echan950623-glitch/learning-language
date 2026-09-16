/**
 * 統計計算，全部從實際保存的 items／attempts 推導，不憑印象或假資料。
 */

import type {
  AbilityKind,
  AttemptResult,
  Language,
  LearningItem,
  ReviewAttempt,
  ScheduleState,
  StudySessionExerciseResult,
} from "./types";
import { requiredAbilities } from "./abilities";
import { deriveStatus } from "./srs";
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

function emptyStatusCounts(): StatusCounts {
  return { total: 0, new: 0, learning: 0, mastered: 0, struggling: 0 };
}

/**
 * 漢字練習（recall）／平假名練習（reading）各自的項目狀態統計，讓進度頁能分別看出
 * 兩種能力各自的掌握狀況，而不是只看 combineAbilityStatuses 合併後的單一整體狀態。
 * 只有 requiredAbilities(item) 真的需要那項能力的項目才會計入該能力的統計
 * （純假名項目不需要 reading，所以不會出現在 reading 的統計裡）。
 */
export function computeAbilityStatusCounts(
  items: LearningItem[],
  scheduleStates: ScheduleState[],
  language: Language
): Record<AbilityKind, StatusCounts> {
  const scheduleByKey = new Map(scheduleStates.map((s) => [`${s.learningItemId}:${s.ability}`, s]));
  const result: Record<AbilityKind, StatusCounts> = { recall: emptyStatusCounts(), reading: emptyStatusCounts() };

  for (const item of items) {
    if (item.language !== language) continue;
    for (const ability of requiredAbilities(item)) {
      const schedule = scheduleByKey.get(`${item.id}:${ability}`);
      const status = schedule ? deriveStatus(schedule.streak, schedule.lapseCount, true) : "new";
      result[ability].total += 1;
      result[ability][status] += 1;
    }
  }

  return result;
}

export interface AbilityResultSummary {
  total: number;
  correct: number;
  /** 0～100 的整數百分比；total 為 0 時回傳 0，呼叫端需另外處理「無資料」顯示 */
  accuracyPercent: number;
}

function summarizeResults(results: StudySessionExerciseResult[]): AbilityResultSummary {
  const total = results.length;
  const correct = results.filter((r) => r.result === ("correct" satisfies AttemptResult)).length;
  return { total, correct, accuracyPercent: total > 0 ? Math.round((correct / total) * 100) : 0 };
}

/** 結算頁用：把一次 session 的作答結果拆成漢字練習（recall）與平假名練習（reading）分別的正確率。 */
export function summarizeSessionResultsByAbility(
  results: StudySessionExerciseResult[]
): Record<AbilityKind, AbilityResultSummary> {
  return {
    recall: summarizeResults(results.filter((r) => r.exerciseType === "recall")),
    reading: summarizeResults(results.filter((r) => r.exerciseType === "reading")),
  };
}

export interface AccuracyResult {
  /** 0～100 的整數百分比；sampleSize 為 0 時回傳 0，呼叫端需另外處理「無資料」顯示 */
  accuracyPercent: number;
  sampleSize: number;
}

/**
 * 近 N 日正確率：答對記 1 分、部分答對記 0.5 分、答錯記 0 分，取平均。
 * 2026-09-16 雲端化：從固定 7 天改成可帶入天數，供 MCP `get_learning_context`
 * 的 days=7|30 兩種視窗共用；`computeSevenDayAccuracy` 保留原名與行為，
 * 內部直接呼叫這個函式，既有呼叫端與測試不受影響。
 */
export function computeAccuracyOverWindow(
  attempts: ReviewAttempt[],
  language: Language,
  now: Date,
  days: number
): AccuracyResult {
  const windowStart = addDays(now, -days).getTime();
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

/** 近 7 日正確率；等同 `computeAccuracyOverWindow(attempts, language, now, 7)`。 */
export function computeSevenDayAccuracy(
  attempts: ReviewAttempt[],
  language: Language,
  now: Date
): AccuracyResult {
  return computeAccuracyOverWindow(attempts, language, now, 7);
}

export interface HintRateResult {
  /** 0～100 的整數百分比；sampleSize 為 0 時回傳 0 */
  hintRatePercent: number;
  sampleSize: number;
}

/**
 * 近 N 日提示使用率：這段期間的作答中，用了提示的比例。給 MCP
 * `get_learning_context` 用，目前 App 內的頁面尚未顯示這個指標。
 */
export function computeHintRateOverWindow(
  attempts: ReviewAttempt[],
  language: Language,
  now: Date,
  days: number
): HintRateResult {
  const windowStart = addDays(now, -days).getTime();
  const relevant = attempts.filter(
    (attempt) => attempt.language === language && new Date(attempt.reviewedAt).getTime() >= windowStart
  );

  if (relevant.length === 0) {
    return { hintRatePercent: 0, sampleSize: 0 };
  }

  const hintCount = relevant.filter((attempt) => attempt.usedHint).length;
  return {
    hintRatePercent: Math.round((hintCount / relevant.length) * 100),
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

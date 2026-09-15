import { describe, expect, it } from "vitest";
import { computeSevenDayAccuracy, computeStatusCounts, computeUpcomingReviewOverview } from "./stats";
import type { LearningItem, ReviewAttempt, ScheduleState } from "./types";

const NOW = new Date("2026-09-14T09:00:00.000Z");

function makeItem(overrides: Partial<LearningItem> & { id: string }): LearningItem {
  return {
    language: "ja",
    type: "vocabulary",
    promptZh: "測試",
    answer: "テスト",
    source: "manual",
    tags: [],
    status: "new",
    createdAt: "2026-09-01T00:00:00.000Z",
    isSeed: false,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<ReviewAttempt> & { id: string }): ReviewAttempt {
  return {
    exerciseId: "ex-1",
    learningItemId: "item-1",
    language: "ja",
    exerciseType: "recall",
    sessionId: "session-1",
    result: "correct",
    usedHint: false,
    responseTimeMs: 1000,
    reviewedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("computeStatusCounts", () => {
  it("只統計指定語言，日文與英文互不污染", () => {
    const items: LearningItem[] = [
      makeItem({ id: "ja-1", language: "ja", status: "learning" }),
      makeItem({ id: "ja-2", language: "ja", status: "mastered" }),
      makeItem({ id: "en-1", language: "en", status: "mastered" }),
    ];

    const jaCounts = computeStatusCounts(items, "ja");
    expect(jaCounts.total).toBe(2);
    expect(jaCounts.learning).toBe(1);
    expect(jaCounts.mastered).toBe(1);

    const enCounts = computeStatusCounts(items, "en");
    expect(enCounts.total).toBe(1);
    expect(enCounts.mastered).toBe(1);
    expect(enCounts.learning).toBe(0);
  });

  it("空資料回傳全 0，不會崩潰", () => {
    const counts = computeStatusCounts([], "ja");
    expect(counts).toEqual({ total: 0, new: 0, learning: 0, mastered: 0, struggling: 0 });
  });
});

describe("computeSevenDayAccuracy", () => {
  it("答對記 1 分、部分答對記 0.5 分、答錯記 0 分", () => {
    const attempts: ReviewAttempt[] = [
      makeAttempt({ id: "1", result: "correct" }),
      makeAttempt({ id: "2", result: "partial" }),
      makeAttempt({ id: "3", result: "incorrect" }),
      makeAttempt({ id: "4", result: "correct" }),
    ];

    const { accuracyPercent, sampleSize } = computeSevenDayAccuracy(attempts, "ja", NOW);
    expect(sampleSize).toBe(4);
    // (1 + 0.5 + 0 + 1) / 4 = 0.625 → 63%
    expect(accuracyPercent).toBe(63);
  });

  it("排除超過 7 天的紀錄", () => {
    const attempts: ReviewAttempt[] = [
      makeAttempt({ id: "old", result: "correct", reviewedAt: "2026-09-01T00:00:00.000Z" }),
      makeAttempt({ id: "recent", result: "incorrect" }),
    ];

    const { accuracyPercent, sampleSize } = computeSevenDayAccuracy(attempts, "ja", NOW);
    expect(sampleSize).toBe(1);
    expect(accuracyPercent).toBe(0);
  });

  it("日文與英文的正確率互不影響", () => {
    const attempts: ReviewAttempt[] = [
      makeAttempt({ id: "ja-1", language: "ja", result: "correct" }),
      makeAttempt({ id: "en-1", language: "en", result: "incorrect" }),
    ];

    expect(computeSevenDayAccuracy(attempts, "ja", NOW).accuracyPercent).toBe(100);
    expect(computeSevenDayAccuracy(attempts, "en", NOW).accuracyPercent).toBe(0);
  });

  it("沒有資料時回傳 sampleSize 0 且不崩潰", () => {
    const result = computeSevenDayAccuracy([], "ja", NOW);
    expect(result).toEqual({ accuracyPercent: 0, sampleSize: 0 });
  });
});

describe("computeUpcomingReviewOverview", () => {
  function makeSchedule(
    overrides: Partial<ScheduleState> & { learningItemId: string }
  ): ScheduleState {
    return {
      ability: "recall",
      language: "ja",
      dueAt: NOW.toISOString(),
      intervalDays: 1,
      streak: 1,
      lapseCount: 0,
      ...overrides,
    };
  }

  it("分別統計 1 天內與 7 天內到期的數量", () => {
    const states: ScheduleState[] = [
      makeSchedule({ learningItemId: "a", dueAt: "2026-09-15T00:00:00.000Z" }), // 1 天內
      makeSchedule({ learningItemId: "b", dueAt: "2026-09-18T00:00:00.000Z" }), // 7 天內、非 1 天內
      makeSchedule({ learningItemId: "c", dueAt: "2026-10-01T00:00:00.000Z" }), // 都不算
    ];

    const overview = computeUpcomingReviewOverview(states, "ja", NOW);
    expect(overview.dueWithinOneDay).toBe(1);
    expect(overview.dueWithinWeek).toBe(2);
  });

  it("空資料回傳 0，不崩潰", () => {
    expect(computeUpcomingReviewOverview([], "ja", NOW)).toEqual({ dueWithinOneDay: 0, dueWithinWeek: 0 });
  });
});

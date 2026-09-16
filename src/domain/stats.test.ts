import { describe, expect, it } from "vitest";
import {
  computeAbilityStatusCounts,
  computeAccuracyOverWindow,
  computeHintRateOverWindow,
  computeSevenDayAccuracy,
  computeStatusCounts,
  computeUpcomingReviewOverview,
  summarizeSessionResultsByAbility,
} from "./stats";
import type { LearningItem, ReviewAttempt, ScheduleState, StudySessionExerciseResult } from "./types";

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

describe("computeAccuracyOverWindow", () => {
  it("30 天視窗會納入 7 天視窗會排除的紀錄", () => {
    const attempts: ReviewAttempt[] = [
      makeAttempt({ id: "old", result: "correct", reviewedAt: "2026-08-25T00:00:00.000Z" }), // 20 天前
      makeAttempt({ id: "recent", result: "incorrect" }),
    ];

    expect(computeSevenDayAccuracy(attempts, "ja", NOW).sampleSize).toBe(1);
    const thirtyDay = computeAccuracyOverWindow(attempts, "ja", NOW, 30);
    expect(thirtyDay.sampleSize).toBe(2);
    // (1 + 0) / 2 = 0.5 → 50%
    expect(thirtyDay.accuracyPercent).toBe(50);
  });

  it("computeSevenDayAccuracy 等同 days=7 的特例", () => {
    const attempts: ReviewAttempt[] = [makeAttempt({ id: "1", result: "correct" })];
    expect(computeSevenDayAccuracy(attempts, "ja", NOW)).toEqual(computeAccuracyOverWindow(attempts, "ja", NOW, 7));
  });
});

describe("computeHintRateOverWindow", () => {
  it("計算視窗內使用提示的比例", () => {
    const attempts: ReviewAttempt[] = [
      makeAttempt({ id: "1", usedHint: true }),
      makeAttempt({ id: "2", usedHint: true }),
      makeAttempt({ id: "3", usedHint: false }),
      makeAttempt({ id: "4", usedHint: false }),
    ];

    const result = computeHintRateOverWindow(attempts, "ja", NOW, 7);
    expect(result).toEqual({ hintRatePercent: 50, sampleSize: 4 });
  });

  it("排除視窗外的紀錄", () => {
    const attempts: ReviewAttempt[] = [
      makeAttempt({ id: "old", usedHint: true, reviewedAt: "2026-08-01T00:00:00.000Z" }),
      makeAttempt({ id: "recent", usedHint: false }),
    ];
    expect(computeHintRateOverWindow(attempts, "ja", NOW, 7)).toEqual({ hintRatePercent: 0, sampleSize: 1 });
  });

  it("日文與英文互不影響", () => {
    const attempts: ReviewAttempt[] = [
      makeAttempt({ id: "ja-1", language: "ja", usedHint: true }),
      makeAttempt({ id: "en-1", language: "en", usedHint: false }),
    ];
    expect(computeHintRateOverWindow(attempts, "ja", NOW, 7).hintRatePercent).toBe(100);
    expect(computeHintRateOverWindow(attempts, "en", NOW, 7).hintRatePercent).toBe(0);
  });

  it("沒有資料時回傳 sampleSize 0 且不崩潰", () => {
    expect(computeHintRateOverWindow([], "ja", NOW, 30)).toEqual({ hintRatePercent: 0, sampleSize: 0 });
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

describe("computeAbilityStatusCounts", () => {
  function makeSchedule(overrides: Partial<ScheduleState> & { learningItemId: string; ability: "recall" | "reading" }): ScheduleState {
    return {
      language: "ja",
      dueAt: NOW.toISOString(),
      intervalDays: 1,
      streak: 1,
      lapseCount: 0,
      ...overrides,
    };
  }

  it("漢字項目分別統計 recall 與 reading 兩種能力的狀態", () => {
    const items: LearningItem[] = [
      makeItem({ id: "kanji-1", answer: "先生", reading: "せんせい" }), // 漢字，需要 recall + reading
    ];
    const schedules: ScheduleState[] = [
      makeSchedule({ learningItemId: "kanji-1", ability: "recall", streak: 5, lapseCount: 0 }), // mastered
      makeSchedule({ learningItemId: "kanji-1", ability: "reading", streak: 0, lapseCount: 1 }), // learning
    ];

    const counts = computeAbilityStatusCounts(items, schedules, "ja");
    expect(counts.recall).toEqual({ total: 1, new: 0, learning: 0, mastered: 1, struggling: 0 });
    expect(counts.reading).toEqual({ total: 1, new: 0, learning: 1, mastered: 0, struggling: 0 });
  });

  it("純假名項目不需要 reading，不會計入 reading 統計", () => {
    const items: LearningItem[] = [makeItem({ id: "kana-1", answer: "ありがとう", reading: "ありがとう" })];
    const counts = computeAbilityStatusCounts(items, [], "ja");
    expect(counts.recall.total).toBe(1);
    expect(counts.reading.total).toBe(0);
  });

  it("還沒有排程紀錄的能力算 new", () => {
    const items: LearningItem[] = [makeItem({ id: "kanji-2", answer: "学生", reading: "がくせい" })];
    const counts = computeAbilityStatusCounts(items, [], "ja");
    expect(counts.recall).toEqual({ total: 1, new: 1, learning: 0, mastered: 0, struggling: 0 });
    expect(counts.reading).toEqual({ total: 1, new: 1, learning: 0, mastered: 0, struggling: 0 });
  });

  it("只統計指定語言", () => {
    const items: LearningItem[] = [
      makeItem({ id: "ja-1", language: "ja", answer: "先生", reading: "せんせい" }),
      makeItem({ id: "en-1", language: "en", answer: "hello", reading: undefined }),
    ];
    const counts = computeAbilityStatusCounts(items, [], "en");
    expect(counts.recall.total).toBe(1);
    expect(counts.reading.total).toBe(0);
  });

  it("空資料回傳全 0，不崩潰", () => {
    const counts = computeAbilityStatusCounts([], [], "ja");
    expect(counts.recall).toEqual({ total: 0, new: 0, learning: 0, mastered: 0, struggling: 0 });
    expect(counts.reading).toEqual({ total: 0, new: 0, learning: 0, mastered: 0, struggling: 0 });
  });
});

describe("summarizeSessionResultsByAbility", () => {
  function makeResult(overrides: Partial<StudySessionExerciseResult>): StudySessionExerciseResult {
    return {
      exerciseId: "ex-1",
      learningItemId: "item-1",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 1000,
      ...overrides,
    };
  }

  it("分別計算漢字練習（recall）與平假名練習（reading）的正確率", () => {
    const results: StudySessionExerciseResult[] = [
      makeResult({ exerciseId: "r1", exerciseType: "recall", result: "correct" }),
      makeResult({ exerciseId: "r2", exerciseType: "recall", result: "incorrect" }),
      makeResult({ exerciseId: "d1", exerciseType: "reading", result: "correct" }),
      makeResult({ exerciseId: "d2", exerciseType: "reading", result: "correct" }),
    ];

    const summary = summarizeSessionResultsByAbility(results);
    expect(summary.recall).toEqual({ total: 2, correct: 1, accuracyPercent: 50 });
    expect(summary.reading).toEqual({ total: 2, correct: 2, accuracyPercent: 100 });
  });

  it("某個能力這次 session 沒有出現時，回傳 total 0、accuracyPercent 0（不是 NaN）", () => {
    const results: StudySessionExerciseResult[] = [
      makeResult({ exerciseId: "r1", exerciseType: "recall", result: "correct" }),
    ];
    const summary = summarizeSessionResultsByAbility(results);
    expect(summary.reading).toEqual({ total: 0, correct: 0, accuracyPercent: 0 });
  });

  it("空陣列回傳兩者皆 0，不崩潰", () => {
    const summary = summarizeSessionResultsByAbility([]);
    expect(summary.recall).toEqual({ total: 0, correct: 0, accuracyPercent: 0 });
    expect(summary.reading).toEqual({ total: 0, correct: 0, accuracyPercent: 0 });
  });
});

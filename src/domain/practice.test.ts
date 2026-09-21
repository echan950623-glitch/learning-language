import { describe, expect, it } from "vitest";

import { buildFullReviewUnits, buildQuickQuizUnits, buildWrongAnswerUnits } from "./practice";
import type { LearningItem, ReviewAttempt } from "./types";

function item(overrides: Partial<LearningItem> = {}): LearningItem {
  return {
    id: "item-1",
    language: "ja",
    type: "vocabulary",
    promptZh: "老師",
    answer: "先生",
    reading: "せんせい",
    source: "manual",
    tags: [],
    status: "learning",
    createdAt: "2026-09-01T00:00:00.000Z",
    isSeed: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<ReviewAttempt> = {}): ReviewAttempt {
  return {
    id: "attempt-1",
    exerciseId: "exercise-1",
    learningItemId: "item-1",
    language: "ja",
    exerciseType: "recall",
    sessionId: "session-1",
    result: "incorrect",
    usedHint: false,
    responseTimeMs: 1_000,
    reviewedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildWrongAnswerUnits", () => {
  it("最新一次仍答錯的能力會進入錯題；之後答對就移除", () => {
    const items = [item()];
    const wrong = attempt();

    expect(buildWrongAnswerUnits(items, [wrong])).toEqual([
      { learningItemId: "item-1", ability: "recall", kind: "review" },
    ]);

    const correctedLater = attempt({
      id: "attempt-2",
      exerciseId: "exercise-2",
      result: "correct",
      reviewedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(buildWrongAnswerUnits(items, [wrong, correctedLater])).toEqual([]);
  });

  it("部分答對仍算待加強，漢字與平假名能力分開判斷", () => {
    const attempts = [
      attempt({ result: "partial" }),
      attempt({
        id: "attempt-reading",
        exerciseId: "exercise-reading",
        exerciseType: "reading",
        result: "correct",
      }),
    ];

    expect(buildWrongAnswerUnits([item()], attempts)).toEqual([
      { learningItemId: "item-1", ability: "recall", kind: "review" },
    ]);
  });

  it("忽略已刪除項目的孤兒作答紀錄", () => {
    expect(buildWrongAnswerUnits([], [attempt()])).toEqual([]);
  });
});

describe("buildFullReviewUnits", () => {
  it("只收已實際作答過的單字，不收完全沒出現過的內容", () => {
    const unseen = item({ id: "item-unseen", answer: "猫", reading: "ねこ" });
    const units = buildFullReviewUnits([item(), unseen], [attempt()]);

    expect(new Set(units.map((unit) => unit.learningItemId))).toEqual(new Set(["item-1"]));
  });

  it("已出現的漢字單字會包含漢字與平假名兩種必要能力", () => {
    expect(buildFullReviewUnits([item()], [attempt()])).toEqual([
      { learningItemId: "item-1", ability: "reading", kind: "review" },
      { learningItemId: "item-1", ability: "recall", kind: "review" },
    ]);
  });

  it("尚未練過的能力優先，再依最久沒練排序，讓多次總複習能輪替", () => {
    const older = item({
      id: "older",
      promptZh: "貓",
      answer: "猫",
      reading: "ねこ",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const newer = item({ id: "newer", promptZh: "狗", answer: "犬", reading: "いぬ" });
    const attempts = [
      attempt({ learningItemId: "older", reviewedAt: "2026-09-01T00:00:00.000Z" }),
      attempt({
        id: "attempt-newer",
        exerciseId: "exercise-newer",
        learningItemId: "newer",
        reviewedAt: "2026-09-12T00:00:00.000Z",
      }),
    ];

    expect(buildFullReviewUnits([newer, older], attempts)).toEqual([
      { learningItemId: "older", ability: "reading", kind: "review" },
      { learningItemId: "newer", ability: "reading", kind: "review" },
      { learningItemId: "older", ability: "recall", kind: "review" },
      { learningItemId: "newer", ability: "recall", kind: "review" },
    ]);
  });

  it("純假名單字只建立漢字／單字回想能力，不重複建立 reading", () => {
    const kanaOnly = item({ answer: "ありがとう", reading: "ありがとう" });
    expect(buildFullReviewUnits([kanaOnly], [attempt()])).toEqual([
      { learningItemId: "item-1", ability: "recall", kind: "review" },
    ]);
  });
});

describe("buildQuickQuizUnits", () => {
  it("完全沒作答過的新單字也能出題，並包含所有必要能力", () => {
    expect(buildQuickQuizUnits([item({ status: "new" })], 5, () => 0)).toEqual([
      { learningItemId: "item-1", ability: "reading", kind: "review" },
      { learningItemId: "item-1", ability: "recall", kind: "review" },
    ]);
  });

  it("不依 item status 排除題目", () => {
    const items = (["new", "learning", "mastered", "struggling"] as const).map((status, index) =>
      item({ id: `item-${index}`, status, answer: "ありがとう", reading: "ありがとう" })
    );
    const units = buildQuickQuizUnits(items, 10, () => 0.5);
    expect(new Set(units.map((unit) => unit.learningItemId))).toEqual(new Set(items.map((entry) => entry.id)));
  });

  it("題數遵守設定上限，且不重複抽同一能力", () => {
    const items = Array.from({ length: 8 }, (_, index) => item({ id: `item-${index}` }));
    const units = buildQuickQuizUnits(items, 5, () => 0.5);
    expect(units).toHaveLength(5);
    expect(new Set(units.map((unit) => `${unit.learningItemId}:${unit.ability}`)).size).toBe(5);
  });

  it("洗牌不改動輸入陣列或項目", () => {
    const items = [item(), item({ id: "item-2" })];
    const before = structuredClone(items);
    buildQuickQuizUnits(items, 3, () => 0);
    expect(items).toEqual(before);
  });
});

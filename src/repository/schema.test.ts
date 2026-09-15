import { describe, expect, it } from "vitest";
import { isLearningItem, isReviewAttempt, isScheduleState, isStudySession, sanitizeStore } from "./schema";
import { buildTodayQueue } from "../domain/queue";

const ITEM_A = {
  id: "item-a",
  language: "ja",
  type: "vocabulary",
  promptZh: "學生",
  answer: "学生",
  reading: "がくせい",
  source: "manual",
  tags: [],
  status: "learning",
  createdAt: "2026-09-01T00:00:00.000Z",
  isSeed: false,
};

describe("R2：日期驗證 — 非法 dueAt 不再讓項目從佇列永久消失", () => {
  it("非法 dueAt 的 ScheduleState 會被丟棄，LearningItem 本身保留並重新成為可學新內容", () => {
    const raw = {
      schemaVersion: 2,
      items: [ITEM_A],
      scheduleStates: [
        {
          learningItemId: "item-a",
          ability: "recall",
          language: "ja",
          dueAt: "abc", // 非法日期，過去在 v1 只檢查非空字串會通過，isDueBy() 會變 NaN
          intervalDays: 1,
          streak: 1,
          lapseCount: 0,
        },
      ],
      reviewAttempts: [],
      studySessions: [],
    };

    const { store, usedFallback, droppedCounts } = sanitizeStore(raw);

    expect(usedFallback).toBe(true);
    expect(droppedCounts.scheduleStates).toBe(1);
    expect(store.items).toHaveLength(1); // 項目本身沒有消失
    expect(store.scheduleStates).toHaveLength(0);

    // 沒有合法排程 → buildTodayQueue 把它當成全新內容，可以被重新排進今日學習
    const queue = buildTodayQueue(store.items, store.scheduleStates, new Date("2026-09-15T00:00:00.000Z"), 5);
    expect(queue.newUnits.map((u) => u.item.id)).toContain("item-a");
  });
});

describe("R2：型別守衛 — 各種日期欄位", () => {
  it("LearningItem 的 createdAt 不是合法 ISO 字串會被拒絕", () => {
    expect(isLearningItem({ ...ITEM_A, createdAt: "not-a-date" })).toBe(false);
    expect(isLearningItem({ ...ITEM_A, createdAt: "2026-09-01" })).toBe(false); // 缺時間部分
    expect(isLearningItem(ITEM_A)).toBe(true);
  });

  it("ReviewAttempt 的 reviewedAt 不是合法 ISO 字串會被拒絕", () => {
    const validAttempt = {
      id: "attempt-1",
      exerciseId: "ex-1",
      learningItemId: "item-a",
      language: "ja",
      exerciseType: "recall",
      sessionId: "session-1",
      result: "correct",
      usedHint: false,
      responseTimeMs: 1000,
      reviewedAt: "2026-09-14T09:00:00.000Z",
    };
    expect(isReviewAttempt(validAttempt)).toBe(true);
    expect(isReviewAttempt({ ...validAttempt, reviewedAt: "昨天" })).toBe(false);
  });

  it("StudySession 的 startedAt 不是合法 ISO 字串會被拒絕", () => {
    const validSession = {
      id: "session-1",
      language: "ja",
      status: "in_progress",
      startedAt: "2026-09-14T09:00:00.000Z",
      // in_progress 必須還有下一題（見 R2 內部一致性規則），所以至少要有一個 plannedUnit。
      plannedUnits: [{ learningItemId: "item-a", ability: "recall", kind: "new" }],
      exerciseResults: [],
      newItemIds: [],
      reviewItemIds: [],
    };
    expect(isStudySession(validSession)).toBe(true);
    expect(isStudySession({ ...validSession, startedAt: 12345 })).toBe(false);
    expect(isStudySession({ ...validSession, startedAt: "" })).toBe(false);
  });
});

describe("精準修復 4：嚴格驗證真實存在的日曆日期", () => {
  it("2 月 31 日不存在，即使格式合法也要拒絕（JS Date 會靜默正規化成 3 月）", () => {
    expect(isLearningItem({ ...ITEM_A, createdAt: "2026-02-31T00:00:00.000Z" })).toBe(false);
  });

  it("2 月 30 日不存在，要拒絕", () => {
    expect(isLearningItem({ ...ITEM_A, createdAt: "2026-02-30T00:00:00.000Z" })).toBe(false);
  });

  it("非閏年（2026）的 2 月 29 日不存在，要拒絕", () => {
    expect(isLearningItem({ ...ITEM_A, createdAt: "2026-02-29T00:00:00.000Z" })).toBe(false);
  });

  it("閏年（2024、2028）的 2 月 29 日是合法日期，必須通過", () => {
    expect(isLearningItem({ ...ITEM_A, createdAt: "2024-02-29T00:00:00.000Z" })).toBe(true);
    expect(isLearningItem({ ...ITEM_A, createdAt: "2028-02-29T00:00:00.000Z" })).toBe(true);
  });

  it("一般合法 ISO 日期仍正常通過（不影響既有相容性）", () => {
    expect(isLearningItem({ ...ITEM_A, createdAt: "2026-09-15T09:00:00.000Z" })).toBe(true);
    expect(isLearningItem({ ...ITEM_A, createdAt: "2026-01-01T00:00:00.5Z" })).toBe(true); // 1 位小數毫秒相容
    expect(isLearningItem({ ...ITEM_A, createdAt: "2026-12-31T23:59:59.999Z" })).toBe(true); // 該年最後一天
  });
});

describe("R2：數字欄位驗證", () => {
  const validSchedule = {
    learningItemId: "item-a",
    ability: "recall",
    language: "ja",
    dueAt: "2026-09-15T00:00:00.000Z",
    intervalDays: 1,
    streak: 0,
    lapseCount: 0,
  };

  it("intervalDays 必須是正整數", () => {
    expect(isScheduleState(validSchedule)).toBe(true);
    expect(isScheduleState({ ...validSchedule, intervalDays: 0 })).toBe(false);
    expect(isScheduleState({ ...validSchedule, intervalDays: -1 })).toBe(false);
    expect(isScheduleState({ ...validSchedule, intervalDays: 1.5 })).toBe(false);
  });

  it("streak／lapseCount 不得為負數或小數", () => {
    expect(isScheduleState({ ...validSchedule, streak: -1 })).toBe(false);
    expect(isScheduleState({ ...validSchedule, streak: 1.5 })).toBe(false);
    expect(isScheduleState({ ...validSchedule, lapseCount: -1 })).toBe(false);
    expect(isScheduleState({ ...validSchedule, lapseCount: 2.5 })).toBe(false);
  });

  it("responseTimeMs 不得為負數或小數", () => {
    const validAttempt = {
      id: "attempt-1",
      exerciseId: "ex-1",
      learningItemId: "item-a",
      language: "ja",
      exerciseType: "recall",
      sessionId: "session-1",
      result: "correct",
      usedHint: false,
      responseTimeMs: 1000,
      reviewedAt: "2026-09-14T09:00:00.000Z",
    };
    expect(isReviewAttempt({ ...validAttempt, responseTimeMs: -1 })).toBe(false);
    expect(isReviewAttempt({ ...validAttempt, responseTimeMs: 12.34 })).toBe(false);
  });
});

describe("R2：跨紀錄關聯清理", () => {
  it("ScheduleState 的 language 與對應 LearningItem 不一致時會被丟棄", () => {
    const raw = {
      schemaVersion: 2,
      items: [ITEM_A], // language: ja
      scheduleStates: [
        {
          learningItemId: "item-a",
          ability: "recall",
          language: "en", // 跟 item 的 ja 不一致
          dueAt: "2026-09-15T00:00:00.000Z",
          intervalDays: 1,
          streak: 1,
          lapseCount: 0,
        },
      ],
      reviewAttempts: [],
      studySessions: [],
    };
    const { store, usedFallback } = sanitizeStore(raw);
    expect(usedFallback).toBe(true);
    expect(store.scheduleStates).toHaveLength(0);
    expect(store.items).toHaveLength(1);
  });

  it("孤兒 ScheduleState／ReviewAttempt（對應的 LearningItem 不存在）會被丟棄", () => {
    const raw = {
      schemaVersion: 2,
      items: [], // 沒有任何合法項目
      scheduleStates: [
        {
          learningItemId: "ghost-item",
          ability: "recall",
          language: "ja",
          dueAt: "2026-09-15T00:00:00.000Z",
          intervalDays: 1,
          streak: 1,
          lapseCount: 0,
        },
      ],
      reviewAttempts: [
        {
          id: "attempt-ghost",
          exerciseId: "ex-1",
          learningItemId: "ghost-item",
          language: "ja",
          exerciseType: "recall",
          sessionId: "session-1",
          result: "correct",
          usedHint: false,
          responseTimeMs: 500,
          reviewedAt: "2026-09-14T09:00:00.000Z",
        },
      ],
      studySessions: [],
    };
    const { store, usedFallback, droppedCounts } = sanitizeStore(raw);
    expect(usedFallback).toBe(true);
    expect(store.scheduleStates).toHaveLength(0);
    expect(store.reviewAttempts).toHaveLength(0);
    expect(droppedCounts.scheduleStates).toBe(1);
    expect(droppedCounts.reviewAttempts).toBe(1);
  });

  it("缺少必要陣列（例如 items 根本不是陣列）視為 fallback，不當成合法空陣列", () => {
    const raw = { schemaVersion: 2, items: "not-an-array", scheduleStates: [], reviewAttempts: [], studySessions: [] };
    const { usedFallback, missingArrays } = sanitizeStore(raw);
    expect(usedFallback).toBe(true);
    expect(missingArrays).toContain("items");
  });
});

describe("R2：v1 → v2 migration", () => {
  it("合法 v1 資料會被完整遷移，不會遺失", () => {
    const v1Raw = {
      schemaVersion: 1,
      items: [ITEM_A],
      scheduleStates: [
        {
          // v1 形狀：沒有 ability 欄位
          learningItemId: "item-a",
          language: "ja",
          dueAt: "2026-09-20T00:00:00.000Z",
          intervalDays: 3,
          streak: 2,
          lapseCount: 0,
          lastReviewedAt: "2026-09-14T09:00:00.000Z",
        },
      ],
      reviewAttempts: [
        {
          id: "attempt-1",
          exerciseId: "ex-1",
          learningItemId: "item-a",
          language: "ja",
          exerciseType: "reading",
          sessionId: "session-1",
          result: "correct",
          usedHint: true,
          responseTimeMs: 2000,
          reviewedAt: "2026-09-13T09:00:00.000Z",
        },
      ],
      studySessions: [
        {
          // v1 形狀：沒有 status／plannedUnits
          id: "session-1",
          language: "ja",
          startedAt: "2026-09-13T08:55:00.000Z",
          completedAt: "2026-09-13T09:05:00.000Z",
          exerciseResults: [
            {
              exerciseId: "ex-1",
              learningItemId: "item-a",
              exerciseType: "reading",
              result: "correct",
              usedHint: true,
              responseTimeMs: 2000,
            },
          ],
          newItemIds: ["item-a"],
          reviewItemIds: [],
        },
      ],
    };

    const { store, usedFallback } = sanitizeStore(v1Raw);

    expect(usedFallback).toBe(false); // 乾淨的 v1 資料，遷移本身不算 fallback
    expect(store.schemaVersion).toBe(2);
    expect(store.items).toHaveLength(1);
    expect(store.items[0].id).toBe("item-a");

    expect(store.scheduleStates).toHaveLength(1);
    expect(store.scheduleStates[0]).toMatchObject({
      learningItemId: "item-a",
      ability: "recall", // v1 的單一進度被視為 recall 能力的既有進度
      streak: 2,
      intervalDays: 3,
    });

    expect(store.reviewAttempts).toHaveLength(1);
    expect(store.reviewAttempts[0].id).toBe("attempt-1");

    expect(store.studySessions).toHaveLength(1);
    const migratedSession = store.studySessions[0];
    expect(migratedSession.status).toBe("completed");
    expect(migratedSession.plannedUnits).toEqual([{ learningItemId: "item-a", ability: "reading", kind: "new" }]);
    expect(migratedSession.exerciseResults).toHaveLength(1);
  });

  it("v1 資料中個別壞掉的紀錄會被濾掉，其餘合法資料仍會遷移成功", () => {
    const v1Raw = {
      schemaVersion: 1,
      items: [ITEM_A],
      scheduleStates: [
        { learningItemId: "item-a", language: "ja", dueAt: "abc", intervalDays: 1, streak: 0, lapseCount: 0 }, // 壞的
      ],
      reviewAttempts: [],
      studySessions: [],
    };

    const { store, usedFallback, droppedCounts } = sanitizeStore(v1Raw);
    expect(usedFallback).toBe(true);
    expect(droppedCounts.scheduleStates).toBe(1);
    expect(store.items).toHaveLength(1); // items 本身沒事
  });
});

describe("精準修復 2：StudySession 內部一致性與跨紀錄關聯", () => {
  const baseSession = {
    id: "session-1",
    language: "ja" as const,
    startedAt: "2026-09-14T09:00:00.000Z",
  };

  it("in_progress 且 results.length === plannedUnits.length 視為不合法（沒有下一題卻標 in_progress）", () => {
    const session = {
      ...baseSession,
      status: "in_progress",
      plannedUnits: [{ learningItemId: "item-a", ability: "recall", kind: "new" }],
      exerciseResults: [
        {
          exerciseId: "ex-1",
          learningItemId: "item-a",
          exerciseType: "recall",
          result: "correct",
          usedHint: false,
          responseTimeMs: 500,
        },
      ],
      newItemIds: ["item-a"],
      reviewItemIds: [],
    };
    expect(isStudySession(session)).toBe(false);
  });

  it("result 與同位置的 planned unit 指向不同 item 時不合法", () => {
    const session = {
      ...baseSession,
      status: "in_progress",
      plannedUnits: [
        { learningItemId: "item-a", ability: "recall", kind: "new" },
        { learningItemId: "item-b", ability: "recall", kind: "new" },
      ],
      exerciseResults: [
        {
          exerciseId: "ex-1",
          learningItemId: "item-b", // 應該是 item-a
          exerciseType: "recall",
          result: "correct",
          usedHint: false,
          responseTimeMs: 500,
        },
      ],
      newItemIds: ["item-a", "item-b"],
      reviewItemIds: [],
    };
    expect(isStudySession(session)).toBe(false);
  });

  it("reading unit 搭配 recall 的作答結果（exerciseType 與 ability 不符）時不合法", () => {
    const session = {
      ...baseSession,
      status: "in_progress",
      plannedUnits: [
        { learningItemId: "item-a", ability: "reading", kind: "new" },
        { learningItemId: "item-a", ability: "reading", kind: "review" },
      ],
      exerciseResults: [
        {
          exerciseId: "ex-1",
          learningItemId: "item-a",
          exerciseType: "recall", // planned unit 是 reading
          result: "correct",
          usedHint: false,
          responseTimeMs: 500,
        },
      ],
      newItemIds: ["item-a"],
      reviewItemIds: [],
    };
    expect(isStudySession(session)).toBe(false);
  });

  it("completed 缺 completedAt 時不合法", () => {
    const session = {
      ...baseSession,
      status: "completed",
      plannedUnits: [{ learningItemId: "item-a", ability: "recall", kind: "new" }],
      exerciseResults: [
        {
          exerciseId: "ex-1",
          learningItemId: "item-a",
          exerciseType: "recall",
          result: "correct",
          usedHint: false,
          responseTimeMs: 500,
        },
      ],
      newItemIds: ["item-a"],
      reviewItemIds: [],
      // 沒有 completedAt
    };
    expect(isStudySession(session)).toBe(false);
  });

  it("completed 且題目全部做完、有 completedAt 時合法", () => {
    const session = {
      ...baseSession,
      status: "completed",
      completedAt: "2026-09-14T09:10:00.000Z",
      plannedUnits: [{ learningItemId: "item-a", ability: "recall", kind: "new" }],
      exerciseResults: [
        {
          exerciseId: "ex-1",
          learningItemId: "item-a",
          exerciseType: "recall",
          result: "correct",
          usedHint: false,
          responseTimeMs: 500,
        },
      ],
      newItemIds: ["item-a"],
      reviewItemIds: [],
    };
    expect(isStudySession(session)).toBe(true);
  });

  it("in_progress 引用不存在的 item 時，sanitizeStore 會整個丟棄這個 session（不會讓 /study 卡住）", () => {
    const raw = {
      schemaVersion: 2,
      items: [], // ghost-item 不存在
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [
        {
          id: "session-ghost",
          language: "ja",
          status: "in_progress",
          startedAt: "2026-09-14T09:00:00.000Z",
          plannedUnits: [{ learningItemId: "ghost-item", ability: "recall", kind: "new" }],
          exerciseResults: [],
          newItemIds: ["ghost-item"],
          reviewItemIds: [],
        },
      ],
    };

    const { store, usedFallback, droppedCounts } = sanitizeStore(raw);
    expect(usedFallback).toBe(true);
    expect(store.studySessions).toHaveLength(0);
    expect(droppedCounts.studySessions).toBe(1);
  });

  it("in_progress 引用語言不一致的 item 時，同樣會被整個丟棄", () => {
    const raw = {
      schemaVersion: 2,
      items: [{ ...ITEM_A, language: "en" }], // item 是英文，session 卻是日文
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [
        {
          id: "session-lang-mismatch",
          language: "ja",
          status: "in_progress",
          startedAt: "2026-09-14T09:00:00.000Z",
          plannedUnits: [{ learningItemId: "item-a", ability: "recall", kind: "new" }],
          exerciseResults: [],
          newItemIds: ["item-a"],
          reviewItemIds: [],
        },
      ],
    };

    const { store, usedFallback } = sanitizeStore(raw);
    expect(usedFallback).toBe(true);
    expect(store.studySessions).toHaveLength(0);
  });

  it("completed／abandoned 歷史可以保留已刪除 item 的引用，不會被跨紀錄清理丟棄", () => {
    const raw = {
      schemaVersion: 2,
      items: [], // 項目已被使用者刪除
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [
        {
          id: "session-history",
          language: "ja",
          status: "completed",
          startedAt: "2026-09-14T09:00:00.000Z",
          completedAt: "2026-09-14T09:10:00.000Z",
          plannedUnits: [{ learningItemId: "deleted-item", ability: "recall", kind: "new" }],
          exerciseResults: [
            {
              exerciseId: "ex-1",
              learningItemId: "deleted-item",
              exerciseType: "recall",
              result: "correct",
              usedHint: false,
              responseTimeMs: 500,
            },
          ],
          newItemIds: ["deleted-item"],
          reviewItemIds: [],
        },
      ],
    };

    const { store, usedFallback } = sanitizeStore(raw);
    expect(usedFallback).toBe(false);
    expect(store.studySessions).toHaveLength(1);
    expect(store.studySessions[0].id).toBe("session-history");
  });
});

describe("R2：未知／未來 schemaVersion 安全回退", () => {
  it("schemaVersion 是未來版本時安全回退為空 store", () => {
    const { store, usedFallback } = sanitizeStore({ schemaVersion: 999, items: [ITEM_A] });
    expect(usedFallback).toBe(true);
    expect(store.items).toEqual([]);
  });
});

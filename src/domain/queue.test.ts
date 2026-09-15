import { describe, expect, it } from "vitest";
import { buildTodayQueue, estimateMinutes } from "./queue";
import type { LearningItem, ScheduleState } from "./types";

const NOW = new Date("2026-09-14T09:00:00.000Z");

function makeItem(overrides: Partial<LearningItem> & { id: string }): LearningItem {
  return {
    language: "ja",
    type: "vocabulary",
    promptZh: "測試",
    answer: "テスト",
    reading: "テスト", // 預設跟答案相同 → 純假名、只需要 recall
    source: "manual",
    tags: [],
    status: "new",
    createdAt: "2026-09-01T00:00:00.000Z",
    isSeed: false,
    ...overrides,
  };
}

function makeSchedule(
  overrides: Partial<ScheduleState> & { learningItemId: string; ability: ScheduleState["ability"] }
): ScheduleState {
  return {
    language: "ja",
    dueAt: "2026-09-14T00:00:00.000Z",
    intervalDays: 1,
    streak: 1,
    lapseCount: 0,
    ...overrides,
  };
}

describe("buildTodayQueue — 純假名項目（只需要 recall）", () => {
  it("到期複習排在新內容前面", () => {
    const dueItem = makeItem({ id: "due-1" });
    const newItem = makeItem({ id: "new-1", createdAt: "2026-09-10T00:00:00.000Z" });
    const items = [newItem, dueItem];
    const schedules = [
      makeSchedule({ learningItemId: "due-1", ability: "recall", dueAt: "2026-09-13T00:00:00.000Z" }),
    ];

    const result = buildTodayQueue(items, schedules, NOW, 5);

    expect(result.reviewUnits.map((u) => u.item.id)).toEqual(["due-1"]);
    expect(result.newUnits.map((u) => u.item.id)).toEqual(["new-1"]);
    expect(result.units.map((u) => u.kind)).toEqual(["review", "new"]);
  });

  it("尚未到期的項目不會出現在複習佇列", () => {
    const items = [makeItem({ id: "future-1" })];
    const schedules = [
      makeSchedule({ learningItemId: "future-1", ability: "recall", dueAt: "2026-09-20T00:00:00.000Z" }),
    ];

    const result = buildTodayQueue(items, schedules, NOW, 5);

    expect(result.reviewUnits).toHaveLength(0);
    expect(result.newUnits).toHaveLength(0); // 已有 schedule，不算「新內容」
    expect(result.units).toHaveLength(0);
  });

  it("新內容依 newItemLimit 截斷，且依建立時間排序", () => {
    const items = [
      makeItem({ id: "a", createdAt: "2026-09-03T00:00:00.000Z" }),
      makeItem({ id: "b", createdAt: "2026-09-01T00:00:00.000Z" }),
      makeItem({ id: "c", createdAt: "2026-09-02T00:00:00.000Z" }),
    ];

    const result = buildTodayQueue(items, [], NOW, 2);

    expect(result.newUnits.map((u) => u.item.id)).toEqual(["b", "c"]);
  });

  it("newItemLimit 超過安全上限時仍被截斷", () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      makeItem({ id: `item-${i}`, createdAt: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z` })
    );

    const result = buildTodayQueue(items, [], NOW, 1000);

    expect(result.newUnits).toHaveLength(50);
  });

  it("空資料不會噴錯，回傳空佇列", () => {
    const result = buildTodayQueue([], [], NOW);
    expect(result.reviewUnits).toEqual([]);
    expect(result.newUnits).toEqual([]);
    expect(result.units).toEqual([]);
  });

  it("到期複習依 dueAt 由早到晚排序", () => {
    const items = [makeItem({ id: "later" }), makeItem({ id: "earlier" })];
    const schedules = [
      makeSchedule({ learningItemId: "later", ability: "recall", dueAt: "2026-09-14T08:00:00.000Z" }),
      makeSchedule({ learningItemId: "earlier", ability: "recall", dueAt: "2026-09-12T08:00:00.000Z" }),
    ];

    const result = buildTodayQueue(items, schedules, NOW, 5);

    expect(result.reviewUnits.map((u) => u.item.id)).toEqual(["earlier", "later"]);
  });
});

describe("buildTodayQueue — R1：含漢字讀音項目要跨多個佇列建立才會出現兩種能力", () => {
  function kanjiItem(id: string, createdAt = "2026-09-01T00:00:00.000Z"): LearningItem {
    return makeItem({ id, answer: "学生", reading: "がくせい", createdAt });
  }

  it("完全沒碰過的漢字項目，今天只會出現 recall，不會同時出現 reading", () => {
    const items = [kanjiItem("student-1")];
    const result = buildTodayQueue(items, [], NOW, 5);

    expect(result.newUnits).toHaveLength(1);
    expect(result.newUnits[0].ability).toBe("recall");
  });

  it("recall 已經有排程紀錄、reading 還沒開始時，reading 會被排進新內容補齊", () => {
    const items = [kanjiItem("student-1")];
    const schedules = [
      makeSchedule({ learningItemId: "student-1", ability: "recall", dueAt: "2026-09-20T00:00:00.000Z" }),
    ];

    const result = buildTodayQueue(items, schedules, NOW, 5);

    // recall 還沒到期，不會出現在複習；reading 從沒開始過，出現在新內容補齊
    expect(result.reviewUnits).toHaveLength(0);
    expect(result.newUnits).toHaveLength(1);
    expect(result.newUnits[0]).toMatchObject({ item: { id: "student-1" }, ability: "reading" });
  });

  it("recall 與 reading 都已有排程且都到期時，兩者都會出現在複習佇列", () => {
    const items = [kanjiItem("student-1")];
    const schedules = [
      makeSchedule({ learningItemId: "student-1", ability: "recall", dueAt: "2026-09-13T00:00:00.000Z" }),
      makeSchedule({ learningItemId: "student-1", ability: "reading", dueAt: "2026-09-13T00:00:00.000Z" }),
    ];

    const result = buildTodayQueue(items, schedules, NOW, 5);

    expect(result.reviewUnits).toHaveLength(2);
    expect(result.reviewUnits.map((u) => u.ability).sort()).toEqual(["reading", "recall"].sort());
  });

  it("已補齊能力的項目優先於全新項目排進新內容", () => {
    const pendingReading = kanjiItem("pending-reading", "2026-09-05T00:00:00.000Z");
    const brandNew = kanjiItem("brand-new", "2026-09-01T00:00:00.000Z"); // 更早建立，但完全沒碰過
    const schedules = [
      makeSchedule({ learningItemId: "pending-reading", ability: "recall", dueAt: "2026-09-20T00:00:00.000Z" }),
    ];

    const result = buildTodayQueue([brandNew, pendingReading], schedules, NOW, 5);

    expect(result.newUnits[0]).toMatchObject({ item: { id: "pending-reading" }, ability: "reading" });
    expect(result.newUnits[1]).toMatchObject({ item: { id: "brand-new" }, ability: "recall" });
  });
});

describe("estimateMinutes", () => {
  it("沒有題目時回傳 0 分鐘", () => {
    expect(estimateMinutes(0)).toBe(0);
  });

  it("有題目時至少顯示 1 分鐘", () => {
    expect(estimateMinutes(1, 40)).toBe(1);
  });

  it("依每題秒數換算分鐘並四捨五入", () => {
    expect(estimateMinutes(10, 40)).toBe(7); // 400 秒 ≈ 6.67 分 → 7
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { installMockLocalStorage, type MemoryStorage } from "../test/localStorageMock";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { MemoryLearningRepository } from "./memoryRepository";
import { PersistenceFailedError } from "./errors";
import { STORAGE_KEY, sanitizeStore } from "./schema";
import { __resetRepositorySingletonForTests, getRepository } from "./index";
import { computeNextSchedule } from "../domain/srs";
import type { NewLearningItemInput, StudySessionPlannedUnit } from "../domain/types";

const NOW = new Date("2026-09-15T09:00:00.000Z");
/** 代表「之後的一次複習 session」，晚於 NOW，用來測試跨 session 的排程一致性。 */
const LATER = new Date("2026-09-16T09:00:00.000Z");

function jaInput(overrides: Partial<NewLearningItemInput> = {}): NewLearningItemInput {
  return {
    language: "ja",
    type: "vocabulary",
    promptZh: "你好",
    answer: "こんにちは",
    reading: "こんにちは",
    source: "manual",
    tags: [],
    ...overrides,
  };
}

function enInput(overrides: Partial<NewLearningItemInput> = {}): NewLearningItemInput {
  return {
    language: "en",
    type: "vocabulary",
    promptZh: "你好",
    answer: "hello",
    source: "manual",
    tags: [],
    ...overrides,
  };
}

function kanjiInput(overrides: Partial<NewLearningItemInput> = {}): NewLearningItemInput {
  return {
    language: "ja",
    type: "vocabulary",
    promptZh: "學生",
    answer: "学生",
    reading: "がくせい",
    source: "manual",
    tags: [],
    ...overrides,
  };
}

describe("MemoryLearningRepository — 基本 CRUD 與日英隔離", () => {
  it("durability 是 volatile", () => {
    expect(new MemoryLearningRepository().durability).toBe("volatile");
  });

  it("新增項目後可依語言查詢，日文與英文互不污染", () => {
    const repo = new MemoryLearningRepository();
    repo.addItem(jaInput());
    repo.addItem(enInput());

    expect(repo.listItems({ language: "ja" })).toHaveLength(1);
    expect(repo.listItems({ language: "en" })).toHaveLength(1);
    expect(repo.listItems()).toHaveLength(2);
    expect(repo.listItems({ language: "ja" })[0].answer).toBe("こんにちは");
  });

  it("removeSeedItems 只移除標記為種子的項目，且可限定語言", () => {
    const repo = new MemoryLearningRepository();
    repo.addItem(jaInput({ isSeed: true }));
    repo.addItem(jaInput({ isSeed: false, promptZh: "真實資料" }));
    repo.addItem(enInput({ isSeed: true }));

    const removed = repo.removeSeedItems("ja");
    expect(removed).toBe(1);
    expect(repo.listItems({ language: "ja" })).toHaveLength(1);
    expect(repo.listItems({ language: "ja" })[0].promptZh).toBe("真實資料");
    expect(repo.listItems({ language: "en" })).toHaveLength(1); // 英文種子不受影響
  });

  it("addItemsIfMissing 以內容去重並一次加入整批單字", () => {
    const repo = new MemoryLearningRepository();
    repo.addItem(kanjiInput({ promptZh: "老師", answer: "先生", reading: "せんせい" }));

    const added = repo.addItemsIfMissing([
      kanjiInput({ promptZh: "老師", answer: "先生", reading: "せんせい", isSeed: true }),
      kanjiInput({ promptZh: "貓", answer: "猫", reading: "ねこ", isSeed: true }),
    ]);

    expect(added).toHaveLength(1);
    expect(added[0].answer).toBe("猫");
    expect(repo.listItems({ language: "ja" })).toHaveLength(2);
    expect(repo.addItemsIfMissing([
      kanjiInput({ promptZh: "貓", answer: "猫", reading: "ねこ", isSeed: true }),
    ])).toEqual([]);
  });

  it("空資料查詢不會崩潰，回傳空陣列", () => {
    const repo = new MemoryLearningRepository();
    expect(repo.listItems()).toEqual([]);
    expect(repo.listScheduleStates()).toEqual([]);
    expect(repo.listReviewAttempts()).toEqual([]);
    expect(repo.listStudySessions()).toEqual([]);
    expect(repo.getItem("不存在")).toBeUndefined();
    expect(repo.getScheduleState("不存在", "recall")).toBeUndefined();
    expect(repo.getInProgressSession("ja")).toBeUndefined();
  });
});

describe("recordGradedAttempt — R1：多能力 mastery 整合", () => {
  it("只練 recall、從未練 reading，item 不會 mastered", () => {
    // 一個 planned unit 在單一 session 只會被問一次；streak 累積到 5 代表跨了 5 次
    // 「今日學習」（每次各自新建一個只含這個能力的 session，模擬跨天複習）。
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(kanjiInput());

    let result;
    for (let i = 0; i < 5; i += 1) {
      const session = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: i === 0 ? "new" : "review" }],
        NOW
      );
      result = repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: `ex-recall-${i}`,
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 1000,
        now: NOW,
      });
    }

    expect(result!.schedule.streak).toBe(5);
    expect(result!.itemStatus).toBe("learning"); // reading 從沒作答過，整體不能 mastered
    expect(repo.getItem(item.id)?.status).toBe("learning");
  });

  it("recall 與 reading 都達到 streak 門檻後，item 才會 mastered", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(kanjiInput());

    let last;
    for (let i = 0; i < 5; i += 1) {
      const session = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: i === 0 ? "new" : "review" }],
        NOW
      );
      last = repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: `ex-recall-${i}`,
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 1000,
        now: NOW,
      });
    }
    expect(last!.itemStatus).toBe("learning"); // reading 還沒開始

    for (let i = 0; i < 5; i += 1) {
      const session = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "reading", kind: i === 0 ? "new" : "review" }],
        NOW
      );
      last = repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "reading",
        exerciseId: `ex-reading-${i}`,
        exerciseType: "reading",
        result: "correct",
        usedHint: false,
        responseTimeMs: 1000,
        now: NOW,
      });
    }
    expect(last!.itemStatus).toBe("mastered");
    expect(repo.getItem(item.id)?.status).toBe("mastered");
  });

  it("reading 答錯不影響 recall 自己的排程；reading 自己的能力可能變 struggling", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(kanjiInput());
    const plannedUnits: StudySessionPlannedUnit[] = [
      { learningItemId: item.id, ability: "recall", kind: "new" },
      { learningItemId: item.id, ability: "reading", kind: "new" },
      { learningItemId: item.id, ability: "reading", kind: "review" },
      { learningItemId: item.id, ability: "reading", kind: "review" },
    ];
    const session = repo.getOrCreateInProgressSession("ja", plannedUnits, NOW);

    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-recall-0",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 1000,
      now: NOW,
    });

    let last;
    for (let i = 0; i < 3; i += 1) {
      last = repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "reading",
        exerciseId: `ex-reading-${i}`,
        exerciseType: "reading",
        result: "incorrect",
        usedHint: false,
        responseTimeMs: 1000,
        now: NOW,
      });
    }

    expect(repo.getScheduleState(item.id, "recall")?.streak).toBe(1); // 不受 reading 影響
    expect(repo.getScheduleState(item.id, "reading")?.lapseCount).toBe(3);
    expect(last!.itemStatus).toBe("struggling");
  });

  it("純假名項目（沒有獨立 reading）只練 recall 就能 mastered", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput()); // こんにちは：reading === answer

    let last;
    for (let i = 0; i < 5; i += 1) {
      const session = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: i === 0 ? "new" : "review" }],
        NOW
      );
      last = repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: `ex-${i}`,
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 1000,
        now: NOW,
      });
    }
    expect(last!.itemStatus).toBe("mastered");
  });
});

describe("recordGradedAttempt — 精準修復 1：必須綁定 session 下一個 planned unit", () => {
  function twoItemSession() {
    const repo = new MemoryLearningRepository();
    const itemA = repo.addItem(kanjiInput({ promptZh: "學生", answer: "学生", reading: "がくせい" }));
    const itemB = repo.addItem(kanjiInput({ promptZh: "老師", answer: "先生", reading: "せんせい" }));
    const plannedUnits: StudySessionPlannedUnit[] = [
      { learningItemId: itemA.id, ability: "recall", kind: "new" },
      { learningItemId: itemB.id, ability: "recall", kind: "new" },
    ];
    const session = repo.getOrCreateInProgressSession("ja", plannedUnits, NOW);
    return { repo, itemA, itemB, session };
  }

  function snapshot(repo: MemoryLearningRepository, sessionId: string) {
    return {
      attempts: repo.listReviewAttempts({ language: "ja" }).length,
      scheduleCount: repo.listScheduleStates({ language: "ja" }).length,
      resultsCount: repo.getInProgressSession("ja")?.exerciseResults.length ?? repo.listStudySessions({ language: "ja", status: "all" }).find((s) => s.id === sessionId)?.exerciseResults.length,
    };
  }

  it("傳入錯誤的 learningItemId 會被拒絕，store 完全不變", () => {
    const { repo, itemB, session } = twoItemSession();
    const before = snapshot(repo, session.id);

    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: itemB.id, // 下一題應該是 itemA，不是 itemB
        ability: "recall",
        exerciseId: "ex-wrong-item",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow();

    expect(snapshot(repo, session.id)).toEqual(before);
    expect(repo.getInProgressSession("ja")?.exerciseResults).toHaveLength(0);
  });

  it("傳入錯誤的 ability 會被拒絕，store 完全不變", () => {
    const { repo, itemA, session } = twoItemSession();
    const before = snapshot(repo, session.id);

    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: itemA.id,
        ability: "reading", // 這個 planned unit 規劃的是 recall
        exerciseId: "ex-wrong-ability",
        exerciseType: "reading",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow();

    expect(snapshot(repo, session.id)).toEqual(before);
  });

  it("ability 與 exerciseType 不相符（reading 能力搭配 recall exerciseType）會被拒絕，store 完全不變", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(kanjiInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "reading", kind: "new" }],
      NOW
    );
    const before = snapshot(repo, session.id);

    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "reading", // 跟 planned unit 一致
        exerciseId: "ex-mismatched-type",
        exerciseType: "recall", // 但 exerciseType 跟 ability 不符
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow();

    expect(snapshot(repo, session.id)).toEqual(before);
  });

  it("正確的下一個 planned unit 仍然可以正常評分（確認驗證沒有誤擋合法流程）", () => {
    const { repo, itemA, itemB, session } = twoItemSession();

    const first = repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: itemA.id,
      ability: "recall",
      exerciseId: "ex-a",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });
    expect(first.session.exerciseResults).toHaveLength(1);

    const second = repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: itemB.id,
      ability: "recall",
      exerciseId: "ex-b",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });
    expect(second.session.status).toBe("completed");
    expect(second.session.exerciseResults).toHaveLength(2);
  });
});

describe("recordGradedAttempt — 防重與錯誤情境", () => {
  it("同一個 exerciseId 在同一個 session 重複評分會被拒絕，不會產生第二筆 attempt", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );

    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-dup",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-dup",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow();

    expect(repo.listReviewAttempts({ language: "ja" })).toHaveLength(1);
  });

  it("對已經 completed 的 session 評分會被拒絕", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-1",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });
    // 這個 session 只有一題，上面那次評分後應該已經 completed

    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-2",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow();
  });
});

describe("LocalStorageLearningRepository — 持久化與安全 fallback", () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  it("首次啟動（無存檔）會注入範例種子資料", () => {
    const repo = new LocalStorageLearningRepository();
    const items = repo.listItems({ language: "ja" });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.isSeed)).toBe(true);
  });

  it("新增項目後，用新的 repository 實例重新讀取（模擬重新整理）仍然存在", () => {
    const repo1 = new LocalStorageLearningRepository();
    const added = repo1.addItem(jaInput({ promptZh: "水", answer: "水", reading: "みず" }));

    const repo2 = new LocalStorageLearningRepository();
    const reloaded = repo2.getItem(added.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.answer).toBe("水");
  });

  it("localStorage 內容是壞掉的 JSON 時安全回退為空白狀態，且會建立 corrupt backup", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(() => new LocalStorageLearningRepository()).not.toThrow();
    const repo = new LocalStorageLearningRepository();
    expect(repo.listItems()).toEqual([]);
    expect(window.localStorage.getItem(`${STORAGE_KEY}:corrupt-backup`)).toBe("{not valid json");
  });

  it("localStorage 內容 schemaVersion 不符（含未來版本）時安全回退為空白狀態", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 999, items: [{ garbage: true }] }));
    const repo = new LocalStorageLearningRepository();
    expect(repo.listItems()).toEqual([]);
  });
});

describe("R3：StudySession 中途重整恢復", () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  it("建立 session 後、尚未作答就重載，仍能恢復同一個 session", () => {
    const repo1 = new LocalStorageLearningRepository();
    const item = repo1.addItem(kanjiInput());
    const plannedUnits: StudySessionPlannedUnit[] = [
      { learningItemId: item.id, ability: "recall", kind: "new" },
      { learningItemId: item.id, ability: "reading", kind: "new" },
    ];
    const created = repo1.getOrCreateInProgressSession("ja", plannedUnits, NOW);

    const repo2 = new LocalStorageLearningRepository();
    const resumed = repo2.getInProgressSession("ja");
    expect(resumed?.id).toBe(created.id);
    expect(resumed?.plannedUnits).toEqual(plannedUnits);
    expect(resumed?.exerciseResults).toEqual([]);
  });

  it("完成第一題後重載，第一題不會再次出現、session 仍是 in_progress", () => {
    const repo1 = new LocalStorageLearningRepository();
    const item = repo1.addItem(kanjiInput());
    const plannedUnits: StudySessionPlannedUnit[] = [
      { learningItemId: item.id, ability: "recall", kind: "new" },
      { learningItemId: item.id, ability: "reading", kind: "new" },
    ];
    const session = repo1.getOrCreateInProgressSession("ja", plannedUnits, NOW);
    repo1.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-recall",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 800,
      now: NOW,
    });

    const repo2 = new LocalStorageLearningRepository();
    const resumed = repo2.getInProgressSession("ja");
    expect(resumed?.status).toBe("in_progress");
    expect(resumed?.exerciseResults).toHaveLength(1);
    expect(resumed?.exerciseResults[0].exerciseId).toBe("ex-recall");
    // 已完成的題目在 plannedUnits 裡的位置就是 exerciseResults.length 之前，
    // 頁面用 exerciseResults.length 當作恢復索引即可知道第一題（recall）不用再問一次。
    expect(resumed?.plannedUnits[0].ability).toBe("recall");
  });

  it("重載後繼續完成剩餘題目，最後只有一個 session、每題只有一筆 attempt", () => {
    const repo1 = new LocalStorageLearningRepository();
    const item = repo1.addItem(kanjiInput());
    const plannedUnits: StudySessionPlannedUnit[] = [
      { learningItemId: item.id, ability: "recall", kind: "new" },
      { learningItemId: item.id, ability: "reading", kind: "new" },
    ];
    const session = repo1.getOrCreateInProgressSession("ja", plannedUnits, NOW);
    repo1.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-recall",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 800,
      now: NOW,
    });

    // 模擬重新整理：新的 repository 實例，從 localStorage 重新讀取
    const repo2 = new LocalStorageLearningRepository();
    const resumed = repo2.getInProgressSession("ja")!;
    expect(resumed.exerciseResults).toHaveLength(1);

    const completedResult = repo2.recordGradedAttempt({
      sessionId: resumed.id,
      learningItemId: item.id,
      ability: "reading",
      exerciseId: "ex-reading",
      exerciseType: "reading",
      result: "correct",
      usedHint: false,
      responseTimeMs: 900,
      now: NOW,
    });

    expect(completedResult.session.status).toBe("completed");
    expect(completedResult.session.completedAt).toBeDefined();
    expect(completedResult.session.exerciseResults).toHaveLength(2);

    const repo3 = new LocalStorageLearningRepository();
    expect(repo3.getInProgressSession("ja")).toBeUndefined();
    expect(repo3.listStudySessions({ language: "ja" })).toHaveLength(1);
    expect(repo3.listReviewAttempts({ language: "ja" }).map((a) => a.exerciseId).sort()).toEqual([
      "ex-reading",
      "ex-recall",
    ]);
  });

  it("completed session 不會被 getOrCreateInProgressSession 誤當成可恢復；會建立新的", () => {
    const repo = new LocalStorageLearningRepository();
    const item = repo.addItem(jaInput());
    const firstSession = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: firstSession.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-1",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    const secondSession = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "review" }],
      NOW
    );
    expect(secondSession.id).not.toBe(firstSession.id);
    expect(secondSession.status).toBe("in_progress");
  });

  it("in_progress／abandoned session 不會冒充 listStudySessions 預設（completed-only）的歷史紀錄", () => {
    const repo = new LocalStorageLearningRepository();
    const item = repo.addItem(jaInput());
    const inProgress = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    expect(repo.listStudySessions({ language: "ja" })).toHaveLength(0);

    repo.abandonSession(inProgress.id);
    expect(repo.listStudySessions({ language: "ja" })).toHaveLength(0);
    expect(repo.listStudySessions({ language: "ja", status: "all" })).toHaveLength(1);
    expect(repo.getInProgressSession("ja")).toBeUndefined();
  });

  it("放棄 session 後可以重新開始一個新的 in_progress session", () => {
    const repo = new LocalStorageLearningRepository();
    const item = repo.addItem(jaInput());
    const first = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.abandonSession(first.id);

    const second = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("in_progress");
  });
});

describe("getOrCreateInProgressSession — 輸入驗證（避免寫出 schema 會丟棄的資料）", () => {
  it("拒絕空 plannedUnits，不會建立出「in_progress 卻沒有下一題」的不一致 session", () => {
    const repo = new MemoryLearningRepository();
    repo.addItem(jaInput());

    expect(() => repo.getOrCreateInProgressSession("ja", [], NOW)).toThrow(/plannedUnits/);
    expect(repo.getInProgressSession("ja")).toBeUndefined();
    expect(repo.listStudySessions({ language: "ja", status: "all" })).toHaveLength(0);
  });

  it("拒絕引用不存在的 learningItemId，不會建立 session", () => {
    const repo = new MemoryLearningRepository();
    expect(() =>
      repo.getOrCreateInProgressSession("ja", [{ learningItemId: "missing-item", ability: "recall", kind: "new" }], NOW)
    ).toThrow(/不存在/);
    expect(repo.listStudySessions({ language: "ja", status: "all" })).toHaveLength(0);
  });

  it("拒絕引用語言與 session 不一致的 item，不會建立 session", () => {
    const repo = new MemoryLearningRepository();
    const enItem = repo.addItem(enInput());
    expect(() =>
      repo.getOrCreateInProgressSession("ja", [{ learningItemId: enItem.id, ability: "recall", kind: "new" }], NOW)
    ).toThrow(/語言/);
    expect(repo.listStudySessions({ language: "ja", status: "all" })).toHaveLength(0);
    expect(repo.listStudySessions({ language: "en", status: "all" })).toHaveLength(0);
  });

  it("合法的 plannedUnits 仍正常建立（確認驗證沒有誤擋合法流程）", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    expect(session.status).toBe("in_progress");
    expect(session.plannedUnits).toHaveLength(1);
  });
});

describe("markAttemptCorrect — 「我其實答對了」修正", () => {
  it("修正單一 recall 作答後，只有一筆 attempt，排程等同這題一開始就直接答對", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(kanjiInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-1",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    const outcome = repo.markAttemptCorrect({ sessionId: session.id, exerciseId: "ex-1" });

    expect(repo.listReviewAttempts({ language: "ja" })).toHaveLength(1);
    expect(outcome.attempt.result).toBe("correct");
    expect(outcome.schedule.streak).toBe(1);
    expect(outcome.schedule.lapseCount).toBe(0);
    expect(outcome.schedule.intervalDays).toBe(1);
    expect(outcome.session.exerciseResults[0].result).toBe("correct");

    // 跟「這題一開始就直接答對」的排程完全一致
    const reference = computeNextSchedule(null, "correct", NOW);
    expect(outcome.schedule.streak).toBe(reference.streak);
    expect(outcome.schedule.lapseCount).toBe(reference.lapseCount);
    expect(outcome.schedule.dueAt).toBe(reference.dueAt);
  });

  it("修正較晚一次的作答時，會重放同一個 (item, ability) 之前的作答序列，而不是疊加在錯誤排程上", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());

    // 第一次 session：直接答對，streak 變成 1。
    const sessionA = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: sessionA.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-a",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    // 第二次 session（到期複習）：誤判成 incorrect，之後修正。
    const sessionB = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "review" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: sessionB.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-b",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    const outcome = repo.markAttemptCorrect({ sessionId: sessionB.id, exerciseId: "ex-b" });

    // 等同「兩次都直接答對」：streak 1 → 2，interval 對應 REVIEW_INTERVALS_DAYS[1] = 3 天。
    const afterFirst = computeNextSchedule(null, "correct", NOW);
    const reference = computeNextSchedule(afterFirst, "correct", NOW);
    expect(outcome.schedule.streak).toBe(reference.streak);
    expect(outcome.schedule.intervalDays).toBe(reference.intervalDays);
    expect(repo.listReviewAttempts({ language: "ja" })).toHaveLength(2);
  });

  it("只能修正 session 目前最後一題；已經不是最後一題會被拒絕，且 store 完全不變", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(kanjiInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [
        { learningItemId: item.id, ability: "recall", kind: "new" },
        { learningItemId: item.id, ability: "reading", kind: "new" },
      ],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-first",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });
    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "reading",
      exerciseId: "ex-second",
      exerciseType: "reading",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    const before = {
      attempts: repo.listReviewAttempts({ language: "ja" }),
      schedules: repo.listScheduleStates({ language: "ja" }),
    };

    expect(() => repo.markAttemptCorrect({ sessionId: session.id, exerciseId: "ex-first" })).toThrow();

    expect(repo.listReviewAttempts({ language: "ja" })).toEqual(before.attempts);
    expect(repo.listScheduleStates({ language: "ja" })).toEqual(before.schedules);
  });

  it("不存在的 exerciseId 或 sessionId 會被拒絕", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-1",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    expect(() => repo.markAttemptCorrect({ sessionId: session.id, exerciseId: "ex-missing" })).toThrow();
    expect(() => repo.markAttemptCorrect({ sessionId: "session-missing", exerciseId: "ex-1" })).toThrow();
  });

  it("已經是 completed 的 session（最後一題評分當下就自動完成）仍可以修正最後一題", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    const graded = repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-1",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });
    expect(graded.session.status).toBe("completed"); // 唯一一題，評分當下就完成

    const outcome = repo.markAttemptCorrect({ sessionId: session.id, exerciseId: "ex-1" });
    expect(outcome.attempt.result).toBe("correct");
    expect(outcome.session.status).toBe("completed");
    expect(outcome.session.completedAt).toBe(graded.session.completedAt);
  });

  it("提示後修正為答對，usedHint 仍保留 true", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-1",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: true,
      responseTimeMs: 500,
      now: NOW,
    });

    const outcome = repo.markAttemptCorrect({ sessionId: session.id, exerciseId: "ex-1" });
    expect(outcome.attempt.usedHint).toBe(true);
    expect(outcome.attempt.result).toBe("correct");
  });

  it("漢字項目修正 recall 後，itemStatus 正確合併另一項能力（reading）既有的狀態", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(kanjiInput());

    // reading 先透過 5 次獨立 session（模擬跨天複習）練到 mastered（streak 5）。
    let streak = 0;
    for (let i = 0; i < 5; i += 1) {
      const readingSession = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "reading", kind: i === 0 ? "new" : "review" }],
        NOW
      );
      const result = repo.recordGradedAttempt({
        sessionId: readingSession.id,
        learningItemId: item.id,
        ability: "reading",
        exerciseId: `ex-reading-${i}`,
        exerciseType: "reading",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      });
      streak = result.schedule.streak;
    }
    expect(streak).toBe(5);

    // recall 這次是第一次練，答錯。
    const recallSession = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: recallSession.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-recall",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });
    expect(repo.getItem(item.id)?.status).not.toBe("mastered"); // recall 還沒達標，整體不該是 mastered

    const outcome = repo.markAttemptCorrect({ sessionId: recallSession.id, exerciseId: "ex-recall" });
    // recall streak 1（< mastery 門檻 5），reading 已經 mastered → 合併結果是 learning，不是 mastered。
    expect(outcome.itemStatus).toBe("learning");
    expect(repo.getItem(item.id)?.status).toBe("learning");
  });

  it("持久化失敗時修正不會留下半套資料，attempt／schedule／session 都維持原狀", () => {
    const storage = installMockLocalStorage();
    const repo = new LocalStorageLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );
    repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-1",
      exerciseType: "recall",
      result: "incorrect",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    (storage as MemoryStorage).failNextSetItem(1);
    expect(() => repo.markAttemptCorrect({ sessionId: session.id, exerciseId: "ex-1" })).toThrow(
      PersistenceFailedError
    );

    expect(repo.listReviewAttempts({ language: "ja" })[0].result).toBe("incorrect");
    expect(repo.getScheduleState(item.id, "recall")?.streak).toBe(0);

    // 底層 storage 也要是舊狀態
    const repo2 = new LocalStorageLearningRepository();
    expect(repo2.listReviewAttempts({ language: "ja" })[0].result).toBe("incorrect");
  });

  describe("P1 修復：completed session 之後又有更新的同能力作答時，拒絕修正、不讓排程倒退", () => {
    function sessionAThenSessionB(bResult: "correct" | "incorrect") {
      const repo = new MemoryLearningRepository();
      const item = repo.addItem(jaInput());

      // Session A：唯一一題，答錯，評分當下自動 completed。
      const sessionA = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: "new" }],
        NOW
      );
      const aOutcome = repo.recordGradedAttempt({
        sessionId: sessionA.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-a",
        exerciseType: "recall",
        result: "incorrect",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      });
      expect(aOutcome.session.status).toBe("completed");

      // Session B（之後的複習，同一 item+ability）：真的發生在 session A 之後的作答。
      const sessionB = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: "review" }],
        LATER
      );
      repo.recordGradedAttempt({
        sessionId: sessionB.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-b",
        exerciseType: "recall",
        result: bResult,
        usedHint: false,
        responseTimeMs: 500,
        now: LATER,
      });

      return { repo, item, sessionA, sessionB };
    }

    it("session B 答對後，修正 session A 的舊 attempt 必須被拒絕，且 schedule／attempt／item status 完全不變", () => {
      const { repo, item, sessionA } = sessionAThenSessionB("correct");

      // session B 答對：streak 0→1（lapseCount 維持 A 留下的 1），跟直接重算一致。
      const before = {
        schedule: repo.getScheduleState(item.id, "recall"),
        attempts: repo.listReviewAttempts({ language: "ja" }),
        itemStatus: repo.getItem(item.id)?.status,
        session: repo.listStudySessions({ language: "ja", status: "all" }),
      };
      expect(before.schedule?.streak).toBe(1); // 證明前提：目前排程已經因 session B 前進了

      expect(() => repo.markAttemptCorrect({ sessionId: sessionA.id, exerciseId: "ex-a" })).toThrow(
        /更新的作答紀錄/
      );

      // Store 完全不變：目前排程沒有被「修正 A」倒退回 streak 1（若倒退，這裡仍是 1，
      // 所以更嚴謹的斷言是連 lapseCount／dueAt／attempts／item status 都要逐一核對）。
      expect(repo.getScheduleState(item.id, "recall")).toEqual(before.schedule);
      expect(repo.listReviewAttempts({ language: "ja" })).toEqual(before.attempts);
      expect(repo.getItem(item.id)?.status).toBe(before.itemStatus);
      expect(repo.listStudySessions({ language: "ja", status: "all" })).toEqual(before.session);
      // 明確核對 ex-a 本身沒有被改判成 correct（沒有被偷偷改掉一部分）。
      expect(repo.listReviewAttempts({ language: "ja" }).find((a) => a.exerciseId === "ex-a")?.result).toBe(
        "incorrect"
      );
    });

    it("session B 答錯後（lapseCount 累積成 2），修正 session A 的舊 attempt 依然被拒絕，不會讓 lapseCount／streak 倒退", () => {
      const { repo, item, sessionA } = sessionAThenSessionB("incorrect");

      const before = repo.getScheduleState(item.id, "recall");
      expect(before?.streak).toBe(0);
      expect(before?.lapseCount).toBe(2); // A 一次 lapse + B 一次 lapse

      expect(() => repo.markAttemptCorrect({ sessionId: sessionA.id, exerciseId: "ex-a" })).toThrow();

      expect(repo.getScheduleState(item.id, "recall")).toEqual(before);
    });

    it("反例：session B 不存在時（target 仍是全域最新），修正 session A 照常成功——證明限制只擋「有更新歷史」的情況", () => {
      const repo = new MemoryLearningRepository();
      const item = repo.addItem(jaInput());
      const sessionA = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: "new" }],
        NOW
      );
      repo.recordGradedAttempt({
        sessionId: sessionA.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-a",
        exerciseType: "recall",
        result: "incorrect",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      });

      const outcome = repo.markAttemptCorrect({ sessionId: sessionA.id, exerciseId: "ex-a" });
      expect(outcome.attempt.result).toBe("correct");
      expect(outcome.schedule.streak).toBe(1);
    });
  });

  describe("目標已經是 correct 時的冪等處理（不可做不必要寫入）", () => {
    it("target 已經是 correct 時直接回傳目前狀態，即使 storage 全面損壞也不會拋錯（證明沒有嘗試寫入）", () => {
      const storage = installMockLocalStorage();
      const repo = new LocalStorageLearningRepository();
      const item = repo.addItem(jaInput());
      const session = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: "new" }],
        NOW
      );
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-1",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      });
      const before = repo.getScheduleState(item.id, "recall");

      storage.failSetItemAlways(); // 之後任何真正的寫入都會拋 PersistenceFailedError

      const outcome = repo.markAttemptCorrect({ sessionId: session.id, exerciseId: "ex-1" });

      expect(outcome.attempt.result).toBe("correct");
      expect(outcome.schedule).toEqual(before);
      expect(repo.listReviewAttempts({ language: "ja" })).toHaveLength(1); // 沒有變成第 2 筆
    });

    it("target 已經是 correct、且之後已有更新的同能力作答時，仍然冪等回傳目前（較新的）排程，不拋「排程倒退」錯誤", () => {
      const repo = new MemoryLearningRepository();
      const item = repo.addItem(jaInput());

      const sessionA = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: "new" }],
        NOW
      );
      repo.recordGradedAttempt({
        sessionId: sessionA.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-a",
        exerciseType: "recall",
        result: "correct", // 已經是 correct，不需要修正
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      });

      const sessionB = repo.getOrCreateInProgressSession(
        "ja",
        [{ learningItemId: item.id, ability: "recall", kind: "review" }],
        LATER
      );
      repo.recordGradedAttempt({
        sessionId: sessionB.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-b",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: LATER,
      });

      const currentSchedule = repo.getScheduleState(item.id, "recall");
      expect(currentSchedule?.streak).toBe(2); // A、B 都答對，streak 累積到 2

      // 對已經是 correct 的舊 attempt（ex-a）再呼叫一次修正：冪等、不拋錯、回傳的是
      // 目前（較新）的排程，不是把它拉回 ex-a 當時的 streak 1。
      const outcome = repo.markAttemptCorrect({ sessionId: sessionA.id, exerciseId: "ex-a" });
      expect(outcome.schedule).toEqual(currentSchedule);
      expect(repo.getScheduleState(item.id, "recall")).toEqual(currentSchedule); // store 沒有被動到
    });
  });
});

describe("R4：持久化失敗不得顯示成功或留下半套資料", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = installMockLocalStorage();
    __resetRepositorySingletonForTests();
  });

  it("新增項目時寫入失敗會丟出 PersistenceFailedError，且不會留在 repository 裡", () => {
    const repo = new LocalStorageLearningRepository();
    storage.failNextSetItem(1);

    expect(() => repo.addItem(jaInput({ promptZh: "測試失敗" }))).toThrow(PersistenceFailedError);
    expect(repo.listItems().some((i) => i.promptZh === "測試失敗")).toBe(false);

    // 用另一個實例重新讀取底層 storage，確認真的沒有寫進去（不是只有這個實例記憶體沒更新）。
    const repo2 = new LocalStorageLearningRepository();
    expect(repo2.listItems().some((i) => i.promptZh === "測試失敗")).toBe(false);
  });

  it("整批新增寫入失敗時維持原子性，不留下部分單字", () => {
    const repo = new LocalStorageLearningRepository();
    const before = repo.listItems().length;
    storage.failNextSetItem(1);

    expect(() => repo.addItemsIfMissing([
      kanjiInput({ promptZh: "春天", answer: "春", reading: "はる", isSeed: true }),
      kanjiInput({ promptZh: "夏天", answer: "夏", reading: "なつ", isSeed: true }),
    ])).toThrow(PersistenceFailedError);

    expect(repo.listItems()).toHaveLength(before);
    expect(new LocalStorageLearningRepository().listItems()).toHaveLength(before);
  });

  it("評分寫入失敗不會產生半套 schedule／attempt／session 更新", () => {
    const repo = new LocalStorageLearningRepository();
    const item = repo.addItem(kanjiInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [
        { learningItemId: item.id, ability: "recall", kind: "new" },
        { learningItemId: item.id, ability: "reading", kind: "new" },
      ],
      NOW
    );

    storage.failNextSetItem(1);
    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-fail",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow(PersistenceFailedError);

    expect(repo.getScheduleState(item.id, "recall")).toBeUndefined();
    expect(repo.listReviewAttempts({ language: "ja" })).toHaveLength(0);
    expect(repo.getInProgressSession("ja")?.exerciseResults).toHaveLength(0);
    expect(repo.getItem(item.id)?.status).toBe("new");

    // 底層 storage 也要是舊狀態，不是記憶體以外的地方悄悄寫了一半
    const repo2 = new LocalStorageLearningRepository();
    expect(repo2.getScheduleState(item.id, "recall")).toBeUndefined();
    expect(repo2.listReviewAttempts({ language: "ja" })).toHaveLength(0);
  });

  it("失敗後重試成功，只會寫入一次，不會產生重複 attempt", () => {
    const repo = new LocalStorageLearningRepository();
    const item = repo.addItem(jaInput());
    const session = repo.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );

    storage.failNextSetItem(1);
    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-retry",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow(PersistenceFailedError);

    // 重試同一次呼叫（沒有失敗開關了）
    const outcome = repo.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: item.id,
      ability: "recall",
      exerciseId: "ex-retry",
      exerciseType: "recall",
      result: "correct",
      usedHint: false,
      responseTimeMs: 500,
      now: NOW,
    });

    expect(outcome.schedule.streak).toBe(1);
    expect(repo.listReviewAttempts({ language: "ja" })).toHaveLength(1);
  });

  it("MemoryLearningRepository 的 persistSnapshot 永遠不會失敗", () => {
    const repo = new MemoryLearningRepository();
    expect(() => repo.addItem(jaInput())).not.toThrow();
  });

  it("getRepository()：localStorage 完全不可用時退回 MemoryLearningRepository，durability 為 volatile", () => {
    storage.failSetItemAlways();
    const repo = getRepository();
    expect(repo).toBeInstanceOf(MemoryLearningRepository);
    expect(repo.durability).toBe("volatile");
  });

  it("getRepository()：localStorage 可用時使用 LocalStorageLearningRepository，durability 為 persistent", () => {
    const repo = getRepository();
    expect(repo).toBeInstanceOf(LocalStorageLearningRepository);
    expect(repo.durability).toBe("persistent");
  });
});

describe("sanitizeStore", () => {
  it("非物件輸入安全回退為空 store", () => {
    expect(sanitizeStore(null).store.items).toEqual([]);
    expect(sanitizeStore("字串").store.items).toEqual([]);
    expect(sanitizeStore(undefined).usedFallback).toBe(true);
  });
});

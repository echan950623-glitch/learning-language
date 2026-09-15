import { beforeEach, describe, expect, it } from "vitest";
import { installMockLocalStorage, type MemoryStorage } from "../test/localStorageMock";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { MemoryLearningRepository } from "./memoryRepository";
import { PersistenceFailedError } from "./errors";
import { STORAGE_KEY, sanitizeStore } from "./schema";
import { __resetRepositorySingletonForTests, getRepository } from "./index";
import type { NewLearningItemInput, StudySessionPlannedUnit } from "../domain/types";

const NOW = new Date("2026-09-15T09:00:00.000Z");

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

  it("session 已經沒有下一題時評分會被拒絕，store 完全不變", () => {
    const repo = new MemoryLearningRepository();
    const item = repo.addItem(jaInput());
    // 故意建立一個沒有任何 planned unit 的 session，模擬「已經沒有下一題」。
    const session = repo.getOrCreateInProgressSession("ja", [], NOW);
    const before = snapshot(repo, session.id);

    expect(() =>
      repo.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: item.id,
        ability: "recall",
        exerciseId: "ex-no-next",
        exerciseType: "recall",
        result: "correct",
        usedHint: false,
        responseTimeMs: 500,
        now: NOW,
      })
    ).toThrow(/沒有下一題/);

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

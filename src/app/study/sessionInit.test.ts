import { describe, expect, it } from "vitest";
import { evaluateSessionResume, initializeStudySession } from "./sessionInit";
import { MemoryLearningRepository } from "@/repository/memoryRepository";
import { LocalStorageLearningRepository } from "@/repository/localStorageRepository";
import { installMockLocalStorage, type MemoryStorage } from "@/test/localStorageMock";
import type { NewLearningItemInput, StudySession } from "@/domain/types";

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

describe("evaluateSessionResume（純函式）", () => {
  it("尚未作答且所有 planned unit 引用的項目都存在時可以恢復", () => {
    const itemsById = new Map([["item-a", { id: "item-a" } as never]]);
    const session: Pick<StudySession, "exerciseResults" | "plannedUnits"> = {
      exerciseResults: [],
      plannedUnits: [{ learningItemId: "item-a", ability: "recall", kind: "new" }],
    };
    expect(evaluateSessionResume(session, itemsById)).toEqual({ canResume: true, resumeIndex: 0 });
  });

  it("尚未作答的 planned unit 引用的項目已不存在時不能恢復", () => {
    const itemsById = new Map<string, never>();
    const session: Pick<StudySession, "exerciseResults" | "plannedUnits"> = {
      exerciseResults: [],
      plannedUnits: [{ learningItemId: "missing-item", ability: "recall", kind: "new" }],
    };
    expect(evaluateSessionResume(session, itemsById).canResume).toBe(false);
  });

  it("已作答的題目即使項目已被刪除，也不影響恢復判斷（只看還沒作答的部分）", () => {
    const itemsById = new Map([["item-b", { id: "item-b" } as never]]);
    const session: Pick<StudySession, "exerciseResults" | "plannedUnits"> = {
      exerciseResults: [
        { exerciseId: "ex-1", learningItemId: "item-a-已刪除", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 500 },
      ],
      plannedUnits: [
        { learningItemId: "item-a-已刪除", ability: "recall", kind: "new" },
        { learningItemId: "item-b", ability: "recall", kind: "new" },
      ],
    };
    expect(evaluateSessionResume(session, itemsById)).toEqual({ canResume: true, resumeIndex: 1 });
  });
});

describe("initializeStudySession — 沒有既有 session", () => {
  it("完全沒有內容時回傳 empty", () => {
    const repository = new MemoryLearningRepository();
    const result = initializeStudySession(repository, NOW);
    expect(result.phase).toBe("empty");
  });

  it("有新內容時建立新 session，phase active，resumeIndex 0", () => {
    const repository = new MemoryLearningRepository();
    repository.addItem(jaInput());
    const result = initializeStudySession(repository, NOW);
    expect(result.phase).toBe("active");
    if (result.phase === "active") {
      expect(result.resumeIndex).toBe(0);
      expect(result.session.status).toBe("in_progress");
      expect(result.session.plannedUnits.length).toBeGreaterThan(0);
    }
  });
});

describe("initializeStudySession — 恢復既有 in_progress session", () => {
  it("沒有資料缺口時直接恢復同一個 session", () => {
    const repository = new MemoryLearningRepository();
    const item = repository.addItem(jaInput());
    const created = repository.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: item.id, ability: "recall", kind: "new" }],
      NOW
    );

    const result = initializeStudySession(repository, NOW);
    expect(result.phase).toBe("active");
    if (result.phase === "active") {
      expect(result.session.id).toBe(created.id);
      expect(result.resumeIndex).toBe(0);
    }
  });

  it("有資料缺口且放棄成功時，會建立一個全新的 session（不是恢復壞掉的那個）", () => {
    const repository = new MemoryLearningRepository();
    const gone = repository.addItem(jaInput({ promptZh: "會被刪除" }));
    const stillHere = repository.addItem(jaInput({ promptZh: "還在" }));
    const staleSession = repository.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: gone.id, ability: "recall", kind: "new" }],
      NOW
    );
    repository.removeItem(gone.id); // 造成資料缺口：session 引用的項目消失了

    const result = initializeStudySession(repository, NOW);

    expect(result.phase).toBe("active");
    if (result.phase === "active") {
      expect(result.session.id).not.toBe(staleSession.id);
      expect(result.session.plannedUnits.some((u) => u.learningItemId === stillHere.id)).toBe(true);
    }
    // 舊 session 應該已經被標成 abandoned，不是還卡在 in_progress
    expect(repository.getInProgressSession("ja")?.id).not.toBe(staleSession.id);
  });

  it("有資料缺口但放棄失敗時，回報錯誤、不建立新 session、也不假裝舊 session 可用", () => {
    const storage = installMockLocalStorage();
    const repository = new LocalStorageLearningRepository();
    const gone = repository.addItem(jaInput({ promptZh: "會被刪除" }));
    const staleSession = repository.getOrCreateInProgressSession(
      "ja",
      [{ learningItemId: gone.id, ability: "recall", kind: "new" }],
      NOW
    );
    repository.removeItem(gone.id);

    (storage as MemoryStorage).failNextSetItem(1); // 讓接下來唯一一次 setItem（abandonSession 的持久化）失敗

    const result = initializeStudySession(repository, NOW);

    expect(result.phase).toBe("error");
    if (result.phase === "error") {
      expect(result.message.length).toBeGreaterThan(0);
    }

    // 沒有假裝放棄成功：底層資料裡這個 session 仍然是 in_progress，原封不動。
    const stillInProgress = repository.getInProgressSession("ja");
    expect(stillInProgress?.id).toBe(staleSession.id);
    expect(stillInProgress?.status).toBe("in_progress");

    // 沒有繼續往下建立新 session：整個語言仍然只有這一個 session。
    expect(repository.listStudySessions({ language: "ja", status: "all" })).toHaveLength(1);
  });

  it("放棄失敗回報的錯誤是 describePersistenceError 產生的可讀訊息，不是原始例外物件字串化", () => {
    const storage = installMockLocalStorage();
    const repository = new LocalStorageLearningRepository();
    const gone = repository.addItem(jaInput());
    repository.getOrCreateInProgressSession("ja", [{ learningItemId: gone.id, ability: "recall", kind: "new" }], NOW);
    repository.removeItem(gone.id);

    storage.failNextSetItem(1, () => new DOMException("quota", "QuotaExceededError"));

    const result = initializeStudySession(repository, NOW);
    expect(result.phase).toBe("error");
    if (result.phase === "error") {
      expect(result.message).toContain("儲存空間已滿");
    }
  });
});

describe("initializeStudySession — 建立新 session 本身寫入失敗", () => {
  it("localStorage 寫入失敗時回報 error，不假裝有可用的 session", () => {
    const storage = installMockLocalStorage();
    const repository = new LocalStorageLearningRepository();
    repository.addItem(jaInput());
    storage.failNextSetItem(1);

    const result = initializeStudySession(repository, NOW);
    expect(result.phase).toBe("error");
  });
});

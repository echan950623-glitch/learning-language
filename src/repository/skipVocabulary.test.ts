import { beforeEach, expect, it, vi } from "vitest";
import { MemoryLearningRepository } from "./memoryRepository";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { SyncingLearningRepository } from "./syncingRepository";
import { installMockLocalStorage } from "../test/localStorageMock";
import { accountStorage, setAccountOwner } from "./accountStorage";
import { listOutboxEntries } from "./sync/outbox";
import { __resetSyncEngineForTests } from "./sync/syncEngine";
import { createEmptyStore, sanitizeStore } from "./schema";
import type { LearningRepository } from "./types";

const now = new Date("2026-10-08T08:00:00Z");
beforeEach(() => { installMockLocalStorage(); __resetSyncEngineForTests(); });
function setup(repository: LearningRepository = new MemoryLearningRepository()) {
  const a = repository.addItem({ language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬", reading: "いぬ", source: "manual", tags: [] });
  const b = repository.addItem({ language: "ja", type: "vocabulary", promptZh: "貓", answer: "猫", source: "manual", tags: [] });
  const session = repository.getOrCreateInProgressSession("ja", [
    { learningItemId: a.id, ability: "recall", kind: "review" },
    { learningItemId: b.id, ability: "recall", kind: "review" },
    { learningItemId: a.id, ability: "reading", kind: "review" },
  ], now, { mode: "full" });
  return { repository, a, b, session };
}
it("removes the word's remaining abilities, keeps schedules/items unchanged and resumes at the next word", () => {
  const { repository, a, b, session } = setup();
  const items = repository.listItems();
  const after = repository.skipVocabulary(session.id, 0, a.id, now);
  expect(after.plannedUnits.map(u => u.learningItemId)).toEqual([b.id]);
  expect(after.exerciseResults).toEqual([]);
  expect(repository.listReviewAttempts()).toEqual([]);
  expect(repository.listScheduleStates()).toEqual([]);
  expect(repository.listItems()).toEqual(items);
  expect(repository.getInProgressSession("ja")).toEqual(after);
  expect(() => repository.skipVocabulary(session.id, 0, a.id, now)).toThrow("題目已經變更");
  expect(repository.getInProgressSession("ja")).toEqual(after);
  const end = repository.skipVocabulary(session.id, 0, b.id, now);
  expect(end.status).toBe("completed");
  expect(sanitizeStore({ ...createEmptyStore(), items: repository.listItems(), studySessions: repository.listStudySessions({ status: "all" }) }).usedFallback).toBe(false);
  const next = repository.getOrCreateInProgressSession("ja", session.plannedUnits, now, { mode: "full" });
  expect(next.plannedUnits.some(u => u.learningItemId === a.id)).toBe(true);
});
it("preserves graded answers and their schedule when skipping the last word", () => {
  const { repository, a, b, session } = setup();
  repository.recordGradedAttempt({ sessionId: session.id, learningItemId: a.id, ability: "recall", exerciseId: "first", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 100, now });
  const schedules = repository.listScheduleStates();
  const answers = repository.listReviewAttempts();
  const after = repository.skipVocabulary(session.id, 1, b.id, now);
  expect(after.exerciseResults).toHaveLength(1);
  expect(repository.listScheduleStates()).toEqual(schedules);
  expect(repository.listReviewAttempts()).toEqual(answers);
});
it("persists the skip and outbox atomically; failed outbox write does not move the round", () => {
  setAccountOwner("A");
  const inner = new LocalStorageLearningRepository();
  const { a, session } = setup(inner);
  const repository = new SyncingLearningRepository(inner, "A");
  accountStorage().setItem("learning-language:sync-outbox", "broken");
  expect(() => repository.skipVocabulary(session.id, 0, a.id, now)).toThrow();
  expect(inner.getInProgressSession("ja")).toEqual(session);
  accountStorage().setItem("learning-language:sync-outbox", "[]");
  const after = repository.skipVocabulary(session.id, 0, a.id, now);
  expect(new LocalStorageLearningRepository().getInProgressSession("ja")).toEqual(after);
  expect(listOutboxEntries()).toMatchObject([{ type: "learning_event", payload: { kind: "skip" } }]);
  const spy = vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
  expect(() => repository.skipVocabulary(session.id, 0, after.plannedUnits[0].learningItemId, now)).toThrow();
  expect(inner.getInProgressSession("ja")).toEqual(after);
  spy.mockRestore();
});

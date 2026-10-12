import { beforeEach, expect, it, vi } from "vitest";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { SyncingLearningRepository } from "./syncingRepository";
import { installMockLocalStorage } from "../test/localStorageMock";
import { accountStorage, setAccountOwner, withDataLock } from "./accountStorage";
import { learningItemToRow, rowToLearningItem, listOutboxEntries } from "./sync/outbox";
import { __resetSyncEngineForTests } from "./sync/syncEngine";
import { pauseVocabularyInSession, setVocabularyPaused } from "./vocabularyPause";
import { buildTodayQueue } from "../domain/queue";
import { buildFullReviewUnits, buildQuickQuizUnits, buildWrongAnswerUnits } from "../domain/practice";
import { evidenceItemStatus } from "../domain/stats";
import { evaluateSessionResume } from "../app/study/sessionInit";

const now = new Date("2026-10-10T08:00:00Z");
beforeEach(() => { installMockLocalStorage(); __resetSyncEngineForTests(); });
function setup() {
  const repository = new LocalStorageLearningRepository();
  const word = repository.addItem({ language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬", reading: "いぬ", tags: [], source: "manual" });
  const session = repository.getOrCreateInProgressSession("ja", [
    { learningItemId: word.id, ability: "recall", kind: "review" },
    { learningItemId: word.id, ability: "reading", kind: "review" },
  ], now);
  repository.recordGradedAttempt({ sessionId: session.id, learningItemId: word.id, ability: "recall", exerciseId: "first", exerciseType: "recall", result: "incorrect", usedHint: false, responseTimeMs: 100, now });
  return { repository, word, session: repository.getInProgressSession("ja")! };
}
it("persists a reversible pause without altering attempts, schedules or evidence status; excludes every queue", async () => {
  const { repository, word, session } = setup();
  const attempts = repository.listReviewAttempts(), schedules = repository.listScheduleStates();
  const status = evidenceItemStatus(repository.getItem(word.id)!, schedules);
  const ended = await withDataLock(() => pauseVocabularyInSession(repository, session.id, 1, word.id, now));
  expect(ended.status).toBe("completed");
  const reloaded = new LocalStorageLearningRepository();
  const paused = reloaded.getItem(word.id)!;
  expect(paused.reviewPaused).toBe(true);
  expect(reloaded.listReviewAttempts()).toEqual(attempts);
  expect(reloaded.listScheduleStates()).toEqual(schedules);
  expect(evidenceItemStatus(paused, schedules)).toBe(status);
  expect(rowToLearningItem(learningItemToRow(paused, "A"))).toEqual(paused);
  expect(buildTodayQueue([paused], schedules, new Date("2027-01-01"))).toMatchObject({ reviewUnits: [], newUnits: [] });
  expect(buildQuickQuizUnits([paused], 10)).toEqual([]);
  expect(buildFullReviewUnits([paused], attempts)).toEqual([]);
  expect(buildWrongAnswerUnits([paused], attempts)).toEqual([]);
  await withDataLock(() => setVocabularyPaused(reloaded, word.id, false, now));
  const resumed = new LocalStorageLearningRepository().getItem(word.id)!;
  expect(resumed.reviewPaused).toBe(false);
  expect(rowToLearningItem(learningItemToRow(resumed, "A")).reviewPaused).toBe(false);
  expect(buildQuickQuizUnits([resumed], 10)).toHaveLength(2);
  expect(reloaded.listScheduleStates()).toEqual(schedules);
  expect(reloaded.listReviewAttempts()).toEqual(attempts);
});
it("keeps both sync events in order and rolls back the whole action if outbox persistence fails", async () => {
  setAccountOwner("A");
  const { repository: inner, word, session } = setup();
  const repository = new SyncingLearningRepository(inner, "A");
  accountStorage().setItem("learning-language:sync-outbox", "broken");
  await expect(withDataLock(() => pauseVocabularyInSession(repository, session.id, 1, word.id, now))).rejects.toThrow();
  expect(new LocalStorageLearningRepository().getItem(word.id)?.reviewPaused).toBeUndefined();
  expect(new LocalStorageLearningRepository().getInProgressSession("ja")).toEqual(session);
  accountStorage().setItem("learning-language:sync-outbox", "[]");
  await withDataLock(() => pauseVocabularyInSession(new SyncingLearningRepository(new LocalStorageLearningRepository(), "A"), session.id, 1, word.id, now));
  expect(listOutboxEntries().map(entry => entry.type === "learning_event" ? entry.payload.kind : entry.type)).toEqual(["skip", "edit"]);
  expect(listOutboxEntries()[1]).toMatchObject({ payload: { item: { learning_metadata: { reviewPaused: true } } } });
});
it("does not pause a stale target and does not resume another session containing paused questions", async () => {
  const { repository, word, session } = setup();
  await expect(withDataLock(() => pauseVocabularyInSession(repository, session.id, 0, word.id, now))).rejects.toThrow();
  expect(new LocalStorageLearningRepository().getItem(word.id)?.reviewPaused).toBeUndefined();
  const paused = { ...word, reviewPaused: true };
  expect(evaluateSessionResume(session, new Map([[word.id, paused]])).canResume).toBe(false);
});
it("rolls back the current-round skip when the following pause edit fails", async () => {
  const { repository, word, session } = setup();
  vi.spyOn(repository, "editItem").mockImplementation(() => { throw new Error("edit failed"); });
  await expect(withDataLock(() => pauseVocabularyInSession(repository, session.id, 1, word.id, now))).rejects.toThrow("edit failed");
  const reloaded = new LocalStorageLearningRepository();
  expect(reloaded.getInProgressSession("ja")).toEqual(session);
  expect(reloaded.getItem(word.id)?.reviewPaused).toBeUndefined();
});

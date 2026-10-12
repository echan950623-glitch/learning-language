import { beforeEach, expect, it, vi } from "vitest";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { SyncingLearningRepository } from "./syncingRepository";
import { installMockLocalStorage } from "../test/localStorageMock";
import { accountStorage, setAccountOwner, withDataLock } from "./accountStorage";
import { learningItemToRow, rowToLearningItem, listOutboxEntries } from "./sync/outbox";
import { __resetSyncEngineForTests } from "./sync/syncEngine";
import { requestVocabularyVerification } from "./vocabularyPause";
import { verificationState } from "../domain/automaticVerification";
import { buildTodayQueue } from "../domain/queue";
import { initializeStudySession } from "../app/study/sessionInit";
import { createDailyPlan } from "../domain/learningRules";

const now = new Date("2026-10-11T08:00:00.000Z");
beforeEach(() => { installMockLocalStorage(); __resetSyncEngineForTests(); });
function setup() {
  const repository = new LocalStorageLearningRepository();
  const word = repository.addItem({ language: "ja", type: "vocabulary", promptZh: "預約", answer: "予約", reading: "よやく", tags: [], source: "manual" });
  const session = repository.getOrCreateInProgressSession("ja", [
    { learningItemId: word.id, ability: "recall", kind: "review" },
    { learningItemId: word.id, ability: "reading", kind: "review" },
  ], now);
  repository.recordGradedAttempt({ sessionId: session.id, learningItemId: word.id, ability: "recall", exerciseId: "baseline", exerciseType: "recall", result: "incorrect", usedHint: false, responseTimeMs: 100, now });
  return { repository, word, session: repository.getInProgressSession("ja")! };
}
it("request survives reload/cloud rows, skips only the current round and creates no fabricated evidence", async () => {
  const { repository, word, session } = setup();
  const schedules = repository.listScheduleStates(), attempts = repository.listReviewAttempts();
  await withDataLock(() => requestVocabularyVerification(repository, session.id, 1, word.id, now));
  const restored = new LocalStorageLearningRepository(), item = restored.getItem(word.id)!;
  expect(item.reviewPaused).not.toBe(true);
  expect(item.autoVerificationRequestedAt).toBe(now.toISOString());
  expect(rowToLearningItem(learningItemToRow(item, "A"))).toEqual(item);
  expect(restored.listScheduleStates()).toEqual(schedules);
  expect(restored.listReviewAttempts()).toEqual(attempts);
  expect(verificationState(item, "recall", schedules, attempts).stage).toBe("pending");
  expect(buildTodayQueue([item], schedules, now, 0, attempts).units).toEqual([]);
});
it("automatically asks a different question tomorrow; its frozen question and actual result survive reload", async () => {
  const { repository, word, session } = setup();
  await withDataLock(() => requestVocabularyVerification(repository, session.id, 1, word.id, now));
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const restored = new LocalStorageLearningRepository();
  const plan = createDailyPlan(restored.listItems(), restored.listScheduleStates(), tomorrow, 0, false, undefined, undefined, restored.listReviewAttempts());
  const start = initializeStudySession(restored, tomorrow, 10, 0, plan);
  expect(start.phase).toBe("active");
  if (start.phase !== "active") throw new Error("missing session");
  const unit = start.session.plannedUnits.find(u => u.ability === "recall")!;
  expect(unit.itemSnapshot?.verificationQuestion).toMatchObject({ kind: "context", novel: true });
  expect(unit.itemSnapshot?.promptZh).toContain("（　）");
  const reloaded = new LocalStorageLearningRepository();
  expect(reloaded.getInProgressSession("ja")!.plannedUnits).toEqual(start.session.plannedUnits);
  const current = start.session.plannedUnits[0];
  await withDataLock(() => reloaded.recordGradedAttempt({ sessionId: start.session.id, learningItemId: word.id, ability: current.ability, exerciseId: "actual-check", exerciseType: current.ability,
    result: "incorrect", usedHint: false, responseTimeMs: 100, rawAnswer: "間違い", now: tomorrow }));
  const final = new LocalStorageLearningRepository();
  expect(final.listReviewAttempts()).toHaveLength(2);
  expect(final.listReviewAttempts().at(-1)?.abilityEvidence?.question).toEqual(current.itemSnapshot);
  expect(verificationState(final.getItem(word.id)!, current.ability, final.listScheduleStates(), final.listReviewAttempts()).stage).toBe("learning");
});
it("queues skip before metadata edit and rolls back both when the edit cannot persist", async () => {
  setAccountOwner("A");
  const { repository, word, session } = setup();
  accountStorage().setItem("learning-language:sync-outbox", "[]");
  await withDataLock(() => requestVocabularyVerification(new SyncingLearningRepository(repository, "A"), session.id, 1, word.id, now));
  expect(listOutboxEntries().map(e => e.type === "learning_event" ? e.payload.kind : e.type)).toEqual(["skip", "edit"]);
  expect(listOutboxEntries()[1]).toMatchObject({ payload: { item: { learning_metadata: { autoVerificationRequestedAt: now.toISOString() } } } });
});
it("rejects stale clicks and preserves the round if its following edit fails", async () => {
  const { repository, word, session } = setup();
  await expect(withDataLock(() => requestVocabularyVerification(repository, session.id, 0, word.id, now))).rejects.toThrow();
  vi.spyOn(repository, "editItem").mockImplementation(() => { throw new Error("edit failed"); });
  await expect(withDataLock(() => requestVocabularyVerification(repository, session.id, 1, word.id, now))).rejects.toThrow("edit failed");
  const restored = new LocalStorageLearningRepository();
  expect(restored.getInProgressSession("ja")).toEqual(session);
  expect(restored.getItem(word.id)?.autoVerificationRequestedAt).toBeUndefined();
});

import { beforeEach, expect, it } from "vitest";
import { installMockLocalStorage } from "../test/localStorageMock";
import { accountKey, accountStorage, getAccountGeneration, isSyncPaused, setAccountOwner } from "./accountStorage";
import { exportLocalBackup, previewLocalBackup, restoreLocalBackup } from "./backup";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { SyncingLearningRepository } from "./syncingRepository";
import { __resetSyncEngineForTests } from "./sync/syncEngine";
import { practiceInput } from "../domain/learningPractice";
import { getJapanesePracticeCatalog } from "../domain/japanesePracticeCatalog";

beforeEach(() => { installMockLocalStorage(); __resetSyncEngineForTests(); setAccountOwner("A"); });
const add = () => new SyncingLearningRepository(new LocalStorageLearningRepository(), "A").addItem({ language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬", source: "manual", tags: [] });
it("restores practice variants, frozen questions and coach observations without regrading", async () => {
  const repository = new SyncingLearningRepository(new LocalStorageLearningRepository(), "A");
  const practice = { ...getJapanesePracticeCatalog()[0].practice, learned: true, enabled: true };
  const item = repository.addItem(practiceInput(practice));
  const now = new Date("2026-10-07T01:00:00.000Z");
  const session = repository.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "review" }], now, { mode: "random" });
  repository.addItem({ language: "ja", type: "phrase", promptZh: "教練觀察", answer: "web-1", source: "ai", tags: [], coachReport: { version: 1, externalId: "web-1", practicedAt: now.toISOString(), source: "gpt", summary: "有提示", observations: [] } });
  await restoreLocalBackup(previewLocalBackup(exportLocalBackup()));
  const restored = new LocalStorageLearningRepository();
  expect(restored.listItems({ includeReports: true })).toHaveLength(2);
  expect(restored.listItems()[0].practice).toEqual(practice);
  expect(restored.listStudySessions({ status: "all" })[0].plannedUnits[0].itemSnapshot).toEqual(session.plannedUnits[0].itemSnapshot);
  expect(restored.listReviewAttempts()).toEqual([]);
});
it("rejects a stale restore preview after another writer saves new progress", async () => {
  add();
  const preview = previewLocalBackup(exportLocalBackup());
  add();
  await expect(restoreLocalBackup(preview)).rejects.toThrow("重新預覽");
  expect(new LocalStorageLearningRepository().listItems()).toHaveLength(2);
});
it("round-trips complete same-account data, preserves a recovery copy and pauses automatic sync", async () => {
  add();
  const preview = previewLocalBackup(exportLocalBackup());
  expect(preview.summary).toMatchObject({ items: 1, pending: 1 });
  const generation = getAccountGeneration();
  await restoreLocalBackup(preview);
  expect(new LocalStorageLearningRepository().listItems()).toHaveLength(1);
  expect(isSyncPaused()).toBe(true);
  expect(getAccountGeneration()).toBeGreaterThan(generation);
  expect(Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).some(key => key?.startsWith(`${accountKey()}:before-restore:`))).toBe(true);
});
it("restores linked attempts, schedules, session results and pending operations without replaying a score", async () => {
  const item = add();
  const repository = new SyncingLearningRepository(new LocalStorageLearningRepository(), "A");
  const now = new Date("2026-10-03T01:00:00.000Z");
  const session = repository.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "new" }], now);
  repository.recordGradedAttempt({ sessionId: session.id, learningItemId: item.id, ability: "recall", exerciseId: "e1", exerciseType: "recall", result: "incorrect", usedHint: false, responseTimeMs: 1000, now });
  const backup = exportLocalBackup();
  const preview = previewLocalBackup(backup);
  expect(preview.summary).toMatchObject({ items: 1, attempts: 1, sessions: 1 });
  await restoreLocalBackup(preview);
  const restored = new LocalStorageLearningRepository();
  expect(restored.listReviewAttempts()).toHaveLength(1);
  expect(restored.getScheduleState(item.id, "recall")?.lapseCount).toBe(1);
  expect(restored.listStudySessions()[0].exerciseResults).toHaveLength(1);
  expect(JSON.parse(exportLocalBackup()).values["learning-language:sync-outbox"]).toBe(JSON.parse(backup).values["learning-language:sync-outbox"]);
});
it("rejects foreign owners, future versions, broken relations and unrecognized sensitive storage", () => {
  const item = add();
  const original = JSON.parse(exportLocalBackup());
  expect(() => previewLocalBackup(JSON.stringify({ ...original, owner: "B" }))).toThrow();
  expect(() => previewLocalBackup(JSON.stringify({ ...original, version: 99 }))).toThrow();
  const broken = structuredClone(original);
  const store = JSON.parse(broken.values["learning-language:store"]);
  store.scheduleStates.push({ learningItemId: "missing", language: "ja", ability: "recall", dueAt: item.createdAt, intervalDays: 1, streak: 0, lapseCount: 0 });
  broken.values["learning-language:store"] = JSON.stringify(store);
  expect(() => previewLocalBackup(JSON.stringify(broken))).toThrow();
  expect(() => previewLocalBackup(JSON.stringify({ ...original, values: { ...original.values, "learning-language:token": "not-a-real-secret" } }))).toThrow();
});
it("does not export auth storage, or unknown keys even if they share the application prefix", () => {
  add();
  window.localStorage.setItem("sb-auth-token", "not-a-real-token");
  accountStorage().setItem("learning-language:token", "not-a-real-token");
  expect(exportLocalBackup()).not.toContain("not-a-real-token");
});
it("rejects malformed recovery journals and nested foreign ownership before replacing data", () => {
  add();
  const backup=JSON.parse(exportLocalBackup());
  backup.values["learning-language:sync-alias-journal:A"]=JSON.stringify([{id:"broken",createdAt:new Date().toISOString(),kind:"item_conflict",conflict:{id:"incomplete"}}]);
  expect(()=>previewLocalBackup(JSON.stringify(backup))).toThrow("不完整");
  delete backup.values["learning-language:sync-alias-journal:A"];
  const pending=JSON.parse(backup.values["learning-language:sync-outbox"]);
  pending[0].payload.user_id="B";
  backup.values["learning-language:sync-outbox"]=JSON.stringify(pending);
  expect(()=>previewLocalBackup(JSON.stringify(backup))).toThrow("帳戶");
  expect(new LocalStorageLearningRepository().listItems()).toHaveLength(1);
});
it("rejects restore after account switch; quota failure leaves live data untouched", async () => {
  add(); const preview = previewLocalBackup(exportLocalBackup());
  setAccountOwner("B");
  await expect(restoreLocalBackup(preview)).rejects.toThrow();
  setAccountOwner("A");
  const fresh = previewLocalBackup(exportLocalBackup());
  const before = window.localStorage.getItem(accountKey());
  const write = window.localStorage.setItem;
  window.localStorage.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  try { await expect(restoreLocalBackup(fresh)).rejects.toThrow(); } finally { window.localStorage.setItem = write; }
  expect(window.localStorage.getItem(accountKey())).toBe(before);
});

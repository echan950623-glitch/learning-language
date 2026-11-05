import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockLocalStorage } from "../../test/localStorageMock";
import {
  __resetRepositorySingletonForTests,
  mutateRepository,
} from "../../repository";
import { LocalStorageLearningRepository } from "../../repository/localStorageRepository";
import { prepareDailyPlan } from "./dailyPlan";
import { readDailyNewItemCap } from "../../lib/studyPreferences";
import { setAccountOwner } from "../../repository/accountStorage";
import { createDailyAreaPlan, dailyAreaUnits } from "../../domain/dailyStudyAreas";
import * as browserClient from "../../lib/supabase/client";
import * as syncEngine from "../../repository/sync/syncEngine";
import { enqueueOutboxEntry, listOutboxEntries } from "../../repository/sync/outbox";

beforeEach(() => {
  installMockLocalStorage();
  __resetRepositorySingletonForTests();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("a blocked FIFO does not prevent a separately approved cloud reservation or remove pending events", async () => {
  const now = new Date("2026-11-05T06:00:00Z");
  setAccountOwner("test-account");
  vi.stubGlobal("navigator", { onLine: true, userAgent: "Node.js" });
  await mutateRepository(repository => {
    for (let i = 0; i < 6; i++) repository.addItem({ language: "ja", type: "vocabulary", promptZh: `詞義${i}`, answer: `単語${i}`, source: "ai", tags: [] });
    const plan = createDailyAreaPlan(repository.listItems({ language: "ja" }), [], now);
    for (let i = 0; i < 41; i++) enqueueOutboxEntry({ type: "learning_event", payload: { id: `blocked-${i}`, kind: "plan", plan } });
  });
  const pending = structuredClone(listOutboxEntries());
  vi.spyOn(syncEngine, "drainOutboxFully").mockResolvedValue({ success: false, kind: "error", message: "sync_conflict:learning_question_changed" });
  const rpc = vi.fn(async (_name, { payload }) => ({ data: { ...payload, newItemIds: payload.newItemIds.slice(0, 2) }, error: null }));
  vi.spyOn(browserClient, "createBrowserClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof browserClient.createBrowserClient>);
  const plan = await prepareDailyPlan(now, "ja", "new");
  expect(rpc).toHaveBeenCalledWith("reserve_daily_plan", expect.any(Object));
  expect(plan.reservationOwner).toBe("test-account");
  expect(plan.newItemIds).toHaveLength(2);
  expect(dailyAreaUnits(plan, "new")).toHaveLength(2);
  // Saving the approved reservation may append a plan event; the blocked prefix
  // must remain byte-for-byte intact and in its original order.
  expect(listOutboxEntries().slice(0, pending.length)).toEqual(pending);
});

it("a failed reservation behind a blocked event never grants local-only new words", async () => {
  const now = new Date("2026-11-05T06:00:00Z");
  setAccountOwner("test-account");
  vi.stubGlobal("navigator", { onLine: true, userAgent: "Node.js" });
  await mutateRepository(repository => repository.addItem({ language: "ja", type: "vocabulary", promptZh: "測試", answer: "試験", source: "ai", tags: [] }));
  vi.spyOn(syncEngine, "drainOutboxFully").mockResolvedValue({ success: false, kind: "error", message: "sync_conflict:learning_question_changed" });
  const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "plan_item_language_mismatch" } });
  vi.spyOn(browserClient, "createBrowserClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof browserClient.createBrowserClient>);
  const plan = await prepareDailyPlan(now, "ja", "new");
  expect(rpc).toHaveBeenCalledOnce();
  expect(plan.newItemIds).toEqual([]);
  expect(dailyAreaUnits(plan, "new")).toEqual([]);
  expect(plan.reason).toContain("設定查看同步診斷");
});
it("offline rebuild only uses the previously reserved cloud words, not newly proposed quota", async () => {
  const now = new Date("2026-10-13T06:00:00Z");
  setAccountOwner("test-account");
  vi.stubGlobal("navigator", { onLine: false, userAgent: "Node.js" });
  const ids = await mutateRepository(repository => {
    for (let index = 0; index < 10; index++) repository.addItem({ language: "ja", type: "vocabulary", promptZh: `詞義 ${index}`, answer: `単語${index}`, source: "ai", tags: [] });
    const plan = createDailyAreaPlan(repository.listItems({ language: "ja" }), [], now);
    plan.newItemIds = plan.newItemIds.slice(0, 3);
    plan.units = plan.units.filter(unit => plan.newItemIds.includes(unit.learningItemId));
    plan.reservationOwner = "test-account";
    repository.saveDailyPlan(plan);
    return plan.newItemIds;
  });
  const rebuilt = await prepareDailyPlan(now, "ja", "new");
  expect(rebuilt.newItemIds).toEqual(ids);
  expect(dailyAreaUnits(rebuilt, "new")).toHaveLength(3);
  __resetRepositorySingletonForTests();
  expect((await prepareDailyPlan(now, "ja", "new")).newItemIds).toEqual(ids);
});
it("without a prior cloud reservation offline new words remain unavailable", async () => {
  const now = new Date("2026-10-13T06:00:00Z");
  setAccountOwner("test-account");
  vi.stubGlobal("navigator", { onLine: false, userAgent: "Node.js" });
  await mutateRepository(repository => repository.addItem({ language: "ja", type: "vocabulary", promptZh: "測試", answer: "試験", source: "ai", tags: [] }));
  const plan = await prepareDailyPlan(now, "ja", "new");
  expect(plan.newItemIds).toEqual([]);
  expect(dailyAreaUnits(plan, "new")).toEqual([]);
  expect(plan.reason).toContain("連線後取得今天的新字額度");
});
it("persists the 50-word quota for the new area and preserves it across reload without a 20-unit plan budget", async () => {
  const now = new Date("2026-10-13T06:00:00Z");
  await mutateRepository(repository => {
    for (let index = 0; index < 60; index++) repository.addItem({ language: "ja", type: "vocabulary", promptZh: `詞義 ${index}`, answer: `単語${index}`, source: "ai", tags: [] });
  });
  const first = await prepareDailyPlan(now, "ja", "new");
  expect(first.newItemIds).toHaveLength(50);
  expect(first.units).toHaveLength(50);
  expect(readDailyNewItemCap()).toBe(50);
  __resetRepositorySingletonForTests();
  expect((await prepareDailyPlan(now, "ja", "new")).newItemIds).toEqual(first.newItemIds);
});
it("persists explicitly added guest content and the daily plan across repository reload", async () => {
  const now = new Date("2026-10-03T06:00:00Z");
  await mutateRepository((repository) => {
    for (let index = 0; index < 6; index++)
      repository.addItem({
        language: "ja",
        type: "vocabulary",
        promptZh: `測試 ${index}`,
        answer: `単語${index}`,
        source: "ai",
        tags: [],
      });
  });
  const first = await prepareDailyPlan(now);
  const restored = new LocalStorageLearningRepository();
  expect(first.newItemIds).toHaveLength(5);
  expect(
    first.units.every((unit) => restored.getItem(unit.learningItemId)),
  ).toBe(true);
  __resetRepositorySingletonForTests();
  expect((await prepareDailyPlan(now)).newItemIds).toEqual(first.newItemIds);
});

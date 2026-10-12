import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { installMockLocalStorage } from "../test/localStorageMock";
import { accountKey, accountStorage, atomicAccountWrite, getAccountOwner, readAccountSnapshot, setAccountOwner, withDataLock } from "./accountStorage";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { SyncingLearningRepository } from "./syncingRepository";
import { createEmptyStore, readPersistedStore, STORAGE_KEY, writePersistedStore } from "./schema";
import { listOutboxEntries, learningItemToRow, studySessionToRow, reviewAttemptToRow } from "./sync/outbox";
import { __resetSyncEngineForTests, drainOutboxFully, pullAndMergeRemoteData } from "./sync/syncEngine";
import { createFakeSupabaseClient, FakeSupabaseDatabase } from "./sync/testSupabaseFake";

const input = { language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬", reading: "いぬ", source: "manual", tags: [] } as const;
const newItem = () => ({ ...input, tags: [] });
beforeEach(() => { installMockLocalStorage(); __resetSyncEngineForTests(); });

it("quota failure commits neither content nor outbox; reload and retry commit both exactly once", () => {
  setAccountOwner("A");
  const inner = new LocalStorageLearningRepository();
  const repository = new SyncingLearningRepository(inner, "A");
  const set = vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => { throw new DOMException("quota", "QuotaExceededError"); });
  expect(() => repository.addItem(newItem())).toThrow();
  expect(inner.listItems()).toHaveLength(0);
  expect(new LocalStorageLearningRepository().listItems()).toHaveLength(0);
  expect(listOutboxEntries()).toHaveLength(0);
  set.mockRestore();
  repository.addItem(newItem());
  expect(new LocalStorageLearningRepository().listItems()).toHaveLength(1);
  expect(listOutboxEntries()).toHaveLength(1);
});

it("outbox serialization failure rolls back the same content snapshot", () => {
  setAccountOwner("A");
  const repository = new SyncingLearningRepository(new LocalStorageLearningRepository(), "A");
  accountStorage().setItem("learning-language:sync-outbox", "broken");
  expect(() => repository.addItem(newItem())).toThrow();
  expect(repository.listItems()).toHaveLength(0);
  expect(accountStorage().getItem("learning-language:sync-outbox")).toBe("broken");
});

it("a thrown interruption before commit leaves the original snapshot and legacy copy intact", () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(createEmptyStore()));
  expect(() => atomicAccountWrite(() => { accountStorage().setItem("learning-language:sync-outbox", "[]"); throw new Error("interrupted"); })).toThrow();
  expect(window.localStorage.getItem(accountKey())).toBeNull();
  expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
});

it("switching accounts isolates preferences, pending operations, and held repository writes", () => {
  setAccountOwner("A");
  const old = new SyncingLearningRepository(new LocalStorageLearningRepository(), "A");
  old.addItem(newItem());
  accountStorage().setItem("learning-language:study-preferences:v1", "20");
  setAccountOwner("B");
  expect(new LocalStorageLearningRepository().listItems()).toHaveLength(0);
  expect(listOutboxEntries()).toHaveLength(0);
  expect(accountStorage().getItem("learning-language:study-preferences:v1")).toBeNull();
  expect(() => old.addItem(newItem())).toThrow();
  setAccountOwner("A");
  expect(listOutboxEntries()).toHaveLength(1);
});

it("a delayed download cannot write after logout", async () => {
  setAccountOwner("A");
  const db = new FakeSupabaseDatabase();
  const repo = new LocalStorageLearningRepository();
  const item = repo.addItem(newItem());
  db.tables.learning_items.rows.push(learningItemToRow(item, "A") as unknown as Record<string, unknown>);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = createFakeSupabaseClient(db);
  const wrapped = { rpc: async () => ({ data: "0", error: null }), from(table: string) { const query = fake.from(table); const then = query.then.bind(query); query.then = ((ok: unknown, bad: unknown) => gate.then(() => then(ok as never, bad as never))) as typeof query.then; return query; } };
  const pending = pullAndMergeRemoteData(wrapped as unknown as SupabaseClient, "A");
  setAccountOwner(null);
  release();
  await pending;
  expect(getAccountOwner()).toBeNull();
  expect(readAccountSnapshot(null).values[STORAGE_KEY]).toBeUndefined();
});
it("a download cannot overwrite a local operation committed while pages are in flight", async () => {
  setAccountOwner("A");
  const db = new FakeSupabaseDatabase();
  const item = new LocalStorageLearningRepository().addItem(newItem());
  db.tables.learning_items.rows.push(learningItemToRow(item, "A") as unknown as Record<string, unknown>);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = createFakeSupabaseClient(db);
  let started = false;
  const wrapped = { rpc: async () => ({ data: "0", error: null }), from(table: string) { const query = fake.from(table); const then = query.then.bind(query); query.then = ((ok: unknown, bad: unknown) => { started = true; return gate.then(() => then(ok as never, bad as never)); }) as typeof query.then; return query; } };
  const pending = pullAndMergeRemoteData(wrapped as unknown as SupabaseClient, "A");
  await vi.waitFor(() => expect(started).toBe(true));
  new LocalStorageLearningRepository().addItem({ ...newItem(), promptZh: "貓", answer: "猫" });
  release();
  await expect(pending).rejects.toThrow("本機已有新作答或資料變更");
  expect(readPersistedStore().items).toHaveLength(2);
});

it("a delayed upload preserves A pending data and cannot mutate B", async () => {
  setAccountOwner("A");
  new SyncingLearningRepository(new LocalStorageLearningRepository(), "A").addItem(newItem());
  let release!: () => void;
  const client = { rpc: () => new Promise(resolve => { release = () => resolve({ error: null, status: 200 }); }) };
  const draining = drainOutboxFully(client as unknown as SupabaseClient);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  setAccountOwner("B");
  release();
  expect((await draining).success).toBe(false);
  expect(listOutboxEntries()).toHaveLength(0);
  setAccountOwner("A");
  expect(listOutboxEntries()).toHaveLength(1);
});

it("downloads 1201 attempts across page boundaries and rebuilds the entire related session", async () => {
  setAccountOwner("A");
  const db = new FakeSupabaseDatabase();
  const repo = new LocalStorageLearningRepository();
  const item = repo.addItem(newItem());
  const session = repo.getOrCreateInProgressSession("ja", Array.from({ length: 1201 }, () => ({ learningItemId: item.id, ability: "recall", kind: "review" })), new Date("2026-01-01T00:00:00.000Z"));
  db.tables.learning_items.rows.push(learningItemToRow(item, "A") as unknown as Record<string, unknown>);
  db.tables.study_sessions.rows.push(studySessionToRow({ ...session, status: "completed", completedAt: "2026-01-01T00:00:00.000Z" }, "A") as unknown as Record<string, unknown>);
  for (let i = 0; i < 1201; i++) db.tables.review_attempts.rows.push(reviewAttemptToRow({ id: `a${String(i).padStart(5, "0")}`, sessionId: session.id, learningItemId: item.id, language: "ja", exerciseId: `e${i}`, exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 100, reviewedAt: "2026-01-01T00:00:00.000Z" }, i, "A") as unknown as Record<string, unknown>);
  writePersistedStore(createEmptyStore());
  await pullAndMergeRemoteData(createFakeSupabaseClient(db) as unknown as SupabaseClient, "A");
  expect(readPersistedStore().reviewAttempts).toHaveLength(1201);
  expect(readPersistedStore().studySessions[0].exerciseResults).toHaveLength(1201);
});

it("holds the browser cross-tab lock for the complete asynchronous operation", async () => {
  const request = vi.fn(async (_key: string, work: () => unknown) => work());
  vi.stubGlobal("navigator", { locks: { request } });
  try { await withDataLock(() => accountStorage().setItem("learning-language:test", "value")); expect(request).toHaveBeenCalledWith(accountKey(), expect.any(Function)); }
  finally { vi.unstubAllGlobals(); }
});

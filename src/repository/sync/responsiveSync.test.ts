import { IDBFactory } from "fake-indexeddb";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockLocalStorage } from "../../test/localStorageMock";
import { getAccountOwner, setAccountOwner, withDataLock } from "../accountStorage";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { SyncingLearningRepository } from "../syncingRepository";
import { readPersistedStore } from "../schema";
import { enqueueLatestPreferences, listOutboxEntries } from "./outbox";
import { __resetSyncEngineForTests, drainOutboxFully } from "./syncEngine";

beforeEach(() => {
  installMockLocalStorage(); __resetSyncEngineForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); setAccountOwner("A");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const addWord = (answer: string) => withDataLock(() =>
  new SyncingLearningRepository(new LocalStorageLearningRepository(), getAccountOwner()!).addItem({
    language: "ja", type: "vocabulary", promptZh: answer, answer, source: "manual", tags: [],
  }));

function slowClient(failure = false) {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const rpc = vi.fn().mockImplementationOnce(async () => {
    await waiting;
    return failure ? { error: { message: "server_rejected" }, status: 400 } : { error: null, status: 200 };
  }).mockResolvedValue({ error: null, status: 200 });
  return { client: { rpc } as unknown as SupabaseClient, rpc, release };
}

it("saves a local answer and newly queued work while an upload is still waiting for HTTP", async () => {
  const item = await addWord("犬");
  const slow = slowClient(), draining = drainOutboxFully(slow.client, undefined, "A");
  try {
    await vi.waitFor(() => expect(slow.rpc).toHaveBeenCalledTimes(1));
    await withDataLock(() => {
      const repo = new SyncingLearningRepository(new LocalStorageLearningRepository(), "A");
      const session = repo.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "new" }], new Date(), { mode: "full" });
      repo.recordGradedAttempt({ sessionId: session.id, learningItemId: item.id, ability: "recall", exerciseId: "slow-answer", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 123, rawAnswer: "犬", now: new Date() });
    });
    expect(readPersistedStore().reviewAttempts).toHaveLength(1);
    expect(listOutboxEntries().some(e => e.type === "learning_event" && e.payload.kind === "attempt")).toBe(true);
    expect(slow.rpc).toHaveBeenCalledTimes(1);
  } finally { slow.release(); await draining; }
  expect(listOutboxEntries()).toEqual([]);
  expect(readPersistedStore().reviewAttempts).toHaveLength(1);
});

it("does not acknowledge a newer preference payload with the response to the older payload", async () => {
  await withDataLock(() => enqueueLatestPreferences({ user_id: "A", daily_question_count: 5, daily_new_item_cap: 5 }));
  const slow = slowClient(), draining = drainOutboxFully(slow.client, undefined, "A");
  try {
    await vi.waitFor(() => expect(slow.rpc).toHaveBeenCalledTimes(1));
    await withDataLock(() => enqueueLatestPreferences({ user_id: "A", daily_question_count: 10, daily_new_item_cap: 50 }));
  } finally { slow.release(); await draining; }
  expect(slow.rpc).toHaveBeenCalledTimes(2);
  expect(slow.rpc.mock.calls[1][1].payload).toMatchObject({ daily_question_count: 10, daily_new_item_cap: 50 });
  expect(listOutboxEntries()).toEqual([]);
});

it("leaves a rejected head and later locally saved work queued in FIFO order", async () => {
  const first = await addWord("first");
  const slow = slowClient(true), draining = drainOutboxFully(slow.client, undefined, "A");
  try {
    await vi.waitFor(() => expect(slow.rpc).toHaveBeenCalledTimes(1));
    await addWord("second");
  } finally { slow.release(); }
  expect(await draining).toMatchObject({ success: false, kind: "error", message: "server_rejected" });
  expect(listOutboxEntries()).toHaveLength(2);
  expect(listOutboxEntries()[0]).toMatchObject({ attempts: 1, payload: { id: first.id } });
  expect(readPersistedStore().items).toHaveLength(2);
});

it("ignores an old account's HTTP response after switching accounts", async () => {
  await addWord("account A");
  const slow = slowClient(), draining = drainOutboxFully(slow.client, undefined, "A");
  try {
    await vi.waitFor(() => expect(slow.rpc).toHaveBeenCalledTimes(1));
    setAccountOwner("B"); await addWord("account B");
  } finally { slow.release(); }
  expect(await draining).toMatchObject({ success: false, kind: "auth" });
  expect(listOutboxEntries()).toHaveLength(1);
  expect(readPersistedStore().items.map(i => i.answer)).toEqual(["account B"]);
  setAccountOwner("A");
  expect(listOutboxEntries()).toHaveLength(1);
});

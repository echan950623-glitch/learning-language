import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { installMockLocalStorage } from "../../test/localStorageMock";
import { setAccountOwner, accountStorage } from "../accountStorage";
import { MemoryLearningRepository } from "../memoryRepository";
import { readPersistedStore, readStoreRevision } from "../schema";
import { learningItemToRow } from "./outbox";
import { createFakeSupabaseClient, FakeSupabaseDatabase } from "./testSupabaseFake";
import { pullAndMergeRemoteData, __resetSyncEngineForTests } from "./syncEngine";
beforeEach(() => { installMockLocalStorage(); __resetSyncEngineForTests(); setAccountOwner("A"); });

it("checks only the revision when cloud data is unchanged, and downloads again when it changes", async () => {
  const repo = new MemoryLearningRepository(), db = new FakeSupabaseDatabase();
  const add = (word: string) => db.table("learning_items").rows.push({ ...learningItemToRow(repo.addItem({ language: "ja", type: "vocabulary", answer: word, promptZh: word, source: "manual", tags: [] }), "A") });
  add("犬");
  const client = createFakeSupabaseClient(db), from = vi.spyOn(client, "from");
  await pullAndMergeRemoteData(client as unknown as SupabaseClient, "A");
  expect(from).toHaveBeenCalledTimes(6);
  const revision = readStoreRevision();
  from.mockClear();
  await pullAndMergeRemoteData(client as unknown as SupabaseClient, "A");
  expect(from).not.toHaveBeenCalled();
  expect(readStoreRevision()).toBe(revision);
  add("猫");
  await pullAndMergeRemoteData(client as unknown as SupabaseClient, "A");
  expect(from).toHaveBeenCalledTimes(6);
  expect(readPersistedStore().items).toHaveLength(2);
});

it("a revision marker alone cannot skip the first download for an empty device", async () => {
  const client = createFakeSupabaseClient(), from = vi.spyOn(client, "from");
  const revision = (await client.rpc("get_learning_revision")).data;
  accountStorage().setItem("learning-language:sync-remote-revision:A", String(revision));
  await pullAndMergeRemoteData(client as unknown as SupabaseClient, "A");
  expect(from).toHaveBeenCalledTimes(6);
});

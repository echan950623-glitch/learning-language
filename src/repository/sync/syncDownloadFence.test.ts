import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { installMockLocalStorage } from "../../test/localStorageMock";
import { questionConflictFixture } from "../../test/questionConflictFixture";
import { setAccountOwner, withDataLock } from "../accountStorage";
import { writePersistedStore, readPersistedStore, readStoreRevision } from "../schema";
import { setOutboxEntries, learningItemToRow, listOutboxEntries } from "./outbox";
import { createFakeSupabaseClient, FakeSupabaseDatabase } from "./testSupabaseFake";
import { pullAndMergeRemoteData, __resetSyncEngineForTests, getSyncStatus } from "./syncEngine";

it("a drain completing after a download snapshot cannot roll back a session even when store revision stays unchanged", async () => {
  installMockLocalStorage(); __resetSyncEngineForTests();
  const f = questionConflictFixture(); setAccountOwner(f.owner);
  await withDataLock(() => { writePersistedStore(f.store); setOutboxEntries(f.entries); });
  const revision = readStoreRevision();
  const db = new FakeSupabaseDatabase();
  db.table("learning_items").rows.push(...f.store.items.map(item => ({ ...learningItemToRow(item, f.owner) })));
  db.table("study_sessions").rows.push({ ...f.remote });
  db.table("review_attempts").rows.push(...f.remoteAnswers.map(a => ({ ...a })));
  const client = createFakeSupabaseClient(db), originalRpc = client.rpc.bind(client);
  let revisionReads = 0;
  client.rpc = async (name, args) => {
    const result = await originalRpc(name, args);
    if (name === "get_learning_revision" && ++revisionReads === 2) {
      // The remote snapshot has been fetched; emulate the queue removal of a
      // successful drain just before the downloader acquires the account lock.
      await withDataLock(() => setOutboxEntries([]));
    }
    return result;
  };
  await expect(pullAndMergeRemoteData(client as unknown as SupabaseClient, f.owner)).rejects.toThrow("待送紀錄已更新");
  expect(listOutboxEntries()).toEqual([]);
  expect(readStoreRevision()).toBe(revision);
  expect(readPersistedStore().studySessions[0]).toEqual(f.store.studySessions[0]);
  expect(getSyncStatus().downloadError).toContain("待送紀錄已更新");
});

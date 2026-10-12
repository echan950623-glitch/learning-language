import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockLocalStorage } from "../test/localStorageMock";
import { accountKey, readAccountSnapshot, resetAccountStorageForTests, setAccountOwner, withDataLock } from "./accountStorage";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { SyncingLearningRepository } from "./syncingRepository";
import { listOutboxEntries } from "./sync/outbox";
import { __resetSyncEngineForTests } from "./sync/syncEngine";
const input = (name: string) => ({ language: "ja", type: "vocabulary", promptZh: name, answer: name, source: "manual", tags: [] } as const);
beforeEach(() => { installMockLocalStorage(); __resetSyncEngineForTests(); vi.stubGlobal("indexedDB", new IDBFactory()); setAccountOwner("A"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const save = (name: string) => withDataLock(() => new SyncingLearningRepository(new LocalStorageLearningRepository(), "A").addItem({ ...input(name), tags: [] }));
it("retries an IndexedDB open failure rather than caching a rejected promise forever", async () => {
  const open = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => { throw new Error("temporary open failure"); });
  await expect(save("甲")).rejects.toThrow("temporary open failure");
  await save("甲");
  expect(open).toHaveBeenCalledTimes(2);
  expect(listOutboxEntries()).toHaveLength(1);
});
it("reloads a committed transaction after a simulated process restart with a stale mirror", async () => {
  const stale = JSON.stringify(readAccountSnapshot());
  await save("甲");
  window.localStorage.setItem(accountKey(), stale);
  resetAccountStorageForTests(); setAccountOwner("A");
  await withDataLock(() => {
    expect(new LocalStorageLearningRepository().listItems().map(i => i.answer)).toEqual(["甲"]);
    expect(listOutboxEntries()).toHaveLength(1);
  });
});
it("account switching aborts an in-flight write before it can publish content or outbox", async () => {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (this: IDBObjectStore, value, key) {
    const request = put.call(this, value, key);
    setAccountOwner("B");
    return request;
  });
  await expect(save("甲")).rejects.toThrow();
  setAccountOwner("A");
  await withDataLock(() => {
    expect(new LocalStorageLearningRepository().listItems()).toHaveLength(0);
    expect(listOutboxEntries()).toHaveLength(0);
  });
});

it("uses IndexedDB as the source even when the localStorage mirror is stale", async () => {
  const stale = JSON.stringify(readAccountSnapshot());
  await save("甲");
  window.localStorage.setItem(accountKey(), stale);
  await save("乙");
  expect(new LocalStorageLearningRepository().listItems().map(item => item.answer)).toEqual(["甲", "乙"]);
  expect(listOutboxEntries()).toHaveLength(2);
});
it("a failed IndexedDB transaction does not publish either store or outbox", async () => {
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new DOMException("quota", "QuotaExceededError"); });
  await expect(save("甲")).rejects.toThrow();
  expect(new LocalStorageLearningRepository().listItems()).toHaveLength(0);
  expect(listOutboxEntries()).toHaveLength(0);
  await save("甲");
  expect(listOutboxEntries()).toHaveLength(1);
});
it("a failed mirror write cannot lose a successfully committed authoritative transaction", async () => {
  vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => { throw new DOMException("quota", "QuotaExceededError"); });
  await save("甲");
  await withDataLock(() => { expect(new LocalStorageLearningRepository().listItems()).toHaveLength(1); expect(listOutboxEntries()).toHaveLength(1); });
});

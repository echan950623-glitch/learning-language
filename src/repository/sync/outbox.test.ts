import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OUTBOX_STORAGE_KEY,
  OutboxPersistenceError,
  enqueueOutboxEntry,
  listOutboxEntries,
} from "./outbox";

class FakeStorage implements Storage {
  readonly data = new Map<string, string>();
  failWrites = false;
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
    this.data.set(key, value);
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => vi.unstubAllGlobals());

describe("outbox persistence", () => {
  it.each(["{broken", "{}", '[{"id":"bad"}]'])("佇列毀損時 fail closed: %s", (raw) => {
    storage.setItem(OUTBOX_STORAGE_KEY, raw);
    expect(() => listOutboxEntries()).toThrow(OutboxPersistenceError);
    expect(storage.getItem(OUTBOX_STORAGE_KEY)).toBe(raw);
  });

  it("寫入失敗時回報錯誤且不假裝已 enqueue", () => {
    storage.failWrites = true;
    expect(() => enqueueOutboxEntry({ type: "delete_items", payload: { ids: ["item-1"] } })).toThrow(
      OutboxPersistenceError
    );
    expect(storage.getItem(OUTBOX_STORAGE_KEY)).toBeNull();
  });
});

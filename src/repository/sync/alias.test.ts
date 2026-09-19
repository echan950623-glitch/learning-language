import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AliasPersistenceError,
  commitAttemptAlias,
  commitItemAlias,
  loadAliasStore,
  resolveCanonicalAttemptId,
  resolveCanonicalItemId,
  resolveLocalItemIdForCanonical,
  translateIncomingAttempt,
  translateIncomingSession,
  translateIncomingSchedule,
  translateOutgoingOperation,
} from "./alias";

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

const userId = "user-a";
const journalKey = `learning-language:sync-alias-journal:${userId}`;
let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => vi.unstubAllGlobals());

describe("durable canonical alias journal", () => {
  it("refresh 後可從 journal 重建雙向 item alias 與 attempt alias", () => {
    commitItemAlias(userId, "local-item", "remote-item", "2026-09-19T00:00:00.000Z");
    commitAttemptAlias(userId, "session-1", "exercise-1", "remote-attempt", "2026-09-19T00:01:00.000Z");

    storage.removeItem(`learning-language:sync-alias:${userId}`);
    const reloaded = loadAliasStore(userId);
    expect(resolveCanonicalItemId(reloaded, "local-item")).toBe("remote-item");
    expect(resolveLocalItemIdForCanonical(reloaded, "remote-item")).toBe("local-item");
    expect(resolveCanonicalAttemptId(reloaded, "session-1", "exercise-1")).toBe("remote-attempt");
  });

  it("重送相同決策為冪等，不重複 append journal", () => {
    commitItemAlias(userId, "local-item", "remote-item");
    const before = storage.getItem(journalKey);
    commitItemAlias(userId, "local-item", "remote-item");
    expect(storage.getItem(journalKey)).toBe(before);
  });

  it("拒絕一對多與多對一 mapping，原 journal 完全不變", () => {
    commitItemAlias(userId, "local-a", "remote-a");
    const before = storage.getItem(journalKey);
    expect(() => commitItemAlias(userId, "local-a", "remote-b")).toThrow(AliasPersistenceError);
    expect(() => commitItemAlias(userId, "local-b", "remote-a")).toThrow(AliasPersistenceError);
    expect(storage.getItem(journalKey)).toBe(before);
  });

  it("拒絕同一 session/exercise 指向不同 remote attempt", () => {
    commitAttemptAlias(userId, "session-1", "exercise-1", "attempt-a");
    const before = storage.getItem(journalKey);
    expect(() => commitAttemptAlias(userId, "session-1", "exercise-1", "attempt-b")).toThrow(AliasPersistenceError);
    expect(storage.getItem(journalKey)).toBe(before);
  });

  it.each(["{broken", "{}", '[{"id":"bad"}]'])("journal 毀損時 fail closed: %s", (raw) => {
    storage.setItem(journalKey, raw);
    expect(() => loadAliasStore(userId)).toThrow(AliasPersistenceError);
  });

  it("journal 或 cache 寫入 quota failure 時拋錯，不回報成功", () => {
    storage.failWrites = true;
    expect(() => commitItemAlias(userId, "local", "remote")).toThrow(AliasPersistenceError);
    expect(storage.getItem(journalKey)).toBeNull();
  });

  it("伺服器端沒有 localStorage 時 fail closed", () => {
    vi.unstubAllGlobals();
    expect(() => loadAliasStore(userId)).toThrow(AliasPersistenceError);
  });

  it("網路邊界翻譯 schedule、attempt、session 的所有巢狀 item reference，且不改原物件", () => {
    const aliases = commitItemAlias(userId, "local-item", "remote-item");
    const session = {
      type: "upsert_session" as const,
      payload: {
        id: "session-1", user_id: userId, language: "ja" as const, status: "completed" as const,
        started_at: "2026-09-19T00:00:00.000Z", completed_at: "2026-09-19T00:01:00.000Z",
        planned_units: [{ learningItemId: "local-item", ability: "recall" as const, kind: "review" as const }],
        new_item_ids: ["local-item"], review_item_ids: ["local-item"],
      },
    };
    const outgoing = translateOutgoingOperation(session, aliases);
    expect(outgoing).not.toBe(session);
    if (outgoing.type !== "upsert_session") throw new Error("unexpected operation");
    expect(outgoing.payload.planned_units[0].learningItemId).toBe("remote-item");
    expect(outgoing.payload.new_item_ids).toEqual(["remote-item"]);
    expect(outgoing.payload.review_item_ids).toEqual(["remote-item"]);
    expect(session.payload.planned_units[0].learningItemId).toBe("local-item");

    const schedule = { user_id: userId, learning_item_id: "remote-item", ability: "recall" as const, language: "ja" as const, due_at: "2026-09-20", interval_days: 1, streak: 1, lapse_count: 0, last_reviewed_at: null };
    expect(translateIncomingSchedule(schedule, aliases).learning_item_id).toBe("local-item");
    const attempt = { id: "a", user_id: userId, session_id: "session-1", sequence_in_session: 0, exercise_id: "e", learning_item_id: "remote-item", language: "ja" as const, exercise_type: "recall" as const, result: "correct" as const, used_hint: false, response_time_ms: 1, reviewed_at: "2026-09-19" };
    expect(translateIncomingAttempt(attempt, aliases).learning_item_id).toBe("local-item");
    expect(translateIncomingSession(outgoing.payload, aliases).planned_units[0].learningItemId).toBe("local-item");
  });
});

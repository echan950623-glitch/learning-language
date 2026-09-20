import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { computeNextSchedule } from "../../domain/srs";
import { installMockLocalStorage, type MemoryStorage } from "../../test/localStorageMock";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { writePersistedStore, type PersistedStore } from "../schema";
import { SyncingLearningRepository } from "../syncingRepository";
import { commitItemAlias } from "./alias";
import { __clearOutboxForTests, enqueueOutboxEntry, listOutboxEntries } from "./outbox";
import { __clearRebaseJournalForTests, readRebaseJournal, rebaseScheduleConflict } from "./scheduleRebase";
import { __resetSyncEngineForTests, drainOutboxFully } from "./syncEngine";
import { createFakeSupabaseClient, FakeSupabaseDatabase, type FakeSupabaseClient } from "./testSupabaseFake";

const USER = "user_1";
const OTHER = "user_2";
const CLOUD_ITEM = "item_cloud_1";
const LOCAL_ITEM = "item_local_1";

const CLOUD_SCHEDULE = {
  due_at: "2026-01-09T00:00:00.000Z",
  interval_days: 3,
  streak: 2,
  lapse_count: 1,
  last_reviewed_at: "2026-01-06T00:00:00.000Z",
};
const T1 = "2026-01-10T00:05:00.000Z";
const T2 = "2026-01-10T00:10:00.000Z";
const ALIAS_AT = "2026-01-09T12:00:00.000Z";

let storage: MemoryStorage;

beforeEach(() => {
  storage = installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
  __clearRebaseJournalForTests(USER);
});

function asClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

function seedCloud(db: FakeSupabaseDatabase, overrides: { id?: string; explanation?: string | null; schedule?: typeof CLOUD_SCHEDULE | null } = {}): void {
  const id = overrides.id ?? CLOUD_ITEM;
  db.tables.learning_items.rows.push({
    id, user_id: USER, language: "ja", type: "vocabulary", prompt_zh: "狗", answer: "犬",
    reading: null, explanation: overrides.explanation ?? null, romaji: null, part_of_speech: null, example_sentence: null,
    source: "manual", tags: [], status: "learning", created_at: "2026-01-01T00:00:00.000Z", is_seed: false,
    content_key: `ja|vocabulary|狗|犬|${id}`,
  });
  const schedule = overrides.schedule === undefined ? CLOUD_SCHEDULE : overrides.schedule;
  if (schedule) {
    db.tables.schedule_states.rows.push({
      user_id: USER, learning_item_id: id, ability: "recall", language: "ja", ...schedule,
    });
  }
}

function writeLocal(overrides: { id?: string; explanation?: string; withSchedule?: boolean } = {}): void {
  const id = overrides.id ?? LOCAL_ITEM;
  const store: PersistedStore = {
    schemaVersion: 2,
    items: [{
      id, language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬",
      source: "manual", tags: [], status: overrides.withSchedule ? "learning" : "new",
      createdAt: "2026-01-02T00:00:00.000Z", isSeed: false,
      ...(overrides.explanation ? { explanation: overrides.explanation } : {}),
    }],
    scheduleStates: overrides.withSchedule
      ? [{
          learningItemId: id, ability: "recall", language: "ja", dueAt: "2026-01-04T00:00:00.000Z",
          intervalDays: 3, streak: 4, lapseCount: 0, lastReviewedAt: "2026-01-01T00:00:00.000Z",
        }]
      : [],
    reviewAttempts: [],
    studySessions: [],
  };
  writePersistedStore(store);
}

function newRepository(): SyncingLearningRepository {
  return new SyncingLearningRepository(new LocalStorageLearningRepository(), USER);
}

let exerciseCounter = 0;

/** 開一個只有一題（本機空白副本 recall）的 session 並作答，回傳 sessionId／exerciseId／attempt。 */
function answer(repository: SyncingLearningRepository, result: "correct" | "incorrect", now: string, itemId: string = LOCAL_ITEM) {
  exerciseCounter += 1;
  const session = repository.getOrCreateInProgressSession(
    "ja",
    [{ learningItemId: itemId, ability: "recall", kind: "new" }],
    new Date(now)
  );
  const exerciseId = `exercise_${exerciseCounter}`;
  const graded = repository.recordGradedAttempt({
    sessionId: session.id, learningItemId: itemId, ability: "recall", exerciseId,
    exerciseType: "recall", result, usedHint: false, responseTimeMs: 500, now: new Date(now),
  });
  return { sessionId: session.id, exerciseId, graded };
}

function cloudSchedule(db: FakeSupabaseDatabase) {
  return db.tables.schedule_states.rows.find((row) => row.learning_item_id === CLOUD_ITEM && row.ability === "recall");
}

function comparableOutbox(): unknown[] {
  return listOutboxEntries().map(({ id, type, payload }) => ({ id, type, payload }));
}

function firstOf(type: string) {
  const entry = listOutboxEntries().find((candidate) => candidate.type === type);
  if (!entry) throw new Error(`missing outbox entry ${type}`);
  return entry;
}

describe("無損重放：本機空白副本已有 alias、雲端已有排程", () => {
  it("1. expected_schedule=null：以雲端排程為基準重算，原始 entry 保留到 RPC 成功，並寫入 journal", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const { graded } = answer(newRepository(), "correct", T1);
    const originalRecord = firstOf("record_graded_attempt");
    if (originalRecord.type !== "record_graded_attempt") throw new Error("unexpected");
    expect(originalRecord.payload.expected_schedule).toBeNull();

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(outcome.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    const expectedNext = computeNextSchedule({ streak: 2, lapseCount: 1 }, "correct", new Date(T1));
    expect(cloudSchedule(db)).toMatchObject({
      streak: 3, lapse_count: 1, interval_days: expectedNext.intervalDays, due_at: expectedNext.dueAt, last_reviewed_at: T1,
    });
    // 沒有把雲端覆蓋成本機舊排程（本機從空白推導只會得到 streak 1）。
    expect(graded.schedule.streak).toBe(1);
    expect(db.tables.review_attempts.rows).toHaveLength(1);
    expect(db.tables.review_attempts.rows[0]).toMatchObject({ id: graded.attempt.id, learning_item_id: CLOUD_ITEM, result: "correct" });
    const journal = readRebaseJournal(USER);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ kind: "record_graded_attempt", canonicalItemId: CLOUD_ITEM, localExpected: null });
    expect(journal[0].originalPayload).toEqual(originalRecord.payload); // 原始 payload 完整留存供復原
  });

  it("2. 兩筆同 item/ability 的 pending 作答：嚴格 FIFO，後一筆以前一筆寫入後的雲端排程為基準", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const repository = newRepository();
    const first = answer(repository, "correct", T1);
    const second = answer(repository, "incorrect", T2);
    const secondRecord = listOutboxEntries().filter((entry) => entry.type === "record_graded_attempt")[1];
    if (secondRecord.type !== "record_graded_attempt") throw new Error("unexpected");
    expect(secondRecord.payload.expected_schedule).not.toBeNull(); // 本機鏈：建立在本機空白基準的結果上

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(outcome.success).toBe(true);
    const step1 = computeNextSchedule({ streak: 2, lapseCount: 1 }, "correct", new Date(T1));
    const step2 = computeNextSchedule({ streak: step1.streak, lapseCount: step1.lapseCount }, "incorrect", new Date(T2));
    expect(cloudSchedule(db)).toMatchObject({ streak: step2.streak, lapse_count: step2.lapseCount, due_at: step2.dueAt, last_reviewed_at: T2 });
    expect(db.tables.review_attempts.rows.map((row) => row.id)).toEqual([first.graded.attempt.id, second.graded.attempt.id]);
    const journal = readRebaseJournal(USER);
    expect(journal.map((entry) => entry.exerciseId)).toEqual([first.exerciseId, second.exerciseId]);
    // 第二筆的重放前排程就是第一筆重放後的雲端排程。
    expect(journal[1].cloudBefore).toEqual(journal[0].cloudAfter);
  });

  it("3＋11. RPC 成功但本機移除前中斷；PWA 重開後重試不重複作答", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const { graded } = answer(newRepository(), "correct", T1);

    const inner = createFakeSupabaseClient(db);
    let armed = true;
    const lostResponse = {
      from: inner.from.bind(inner),
      rpc: async (name: string, args: { payload: Record<string, unknown> }) => {
        const response = await inner.rpc(name, args);
        if (armed && name === "record_graded_attempt" && !response.error) {
          armed = false;
          throw new Error("network lost after commit");
        }
        return response;
      },
    } as unknown as SupabaseClient;

    const first = await drainOutboxFully(lostResponse, undefined, USER);
    expect(first.success).toBe(false);
    expect(db.tables.review_attempts.rows).toHaveLength(1); // 雲端已寫入
    expect(listOutboxEntries().map((entry) => entry.type)).toEqual(["record_graded_attempt"]); // entry 仍在
    const scheduleAfterFirst = { ...cloudSchedule(db) };

    __resetSyncEngineForTests(); // PWA 關閉重開：模組狀態消失，只剩 localStorage
    const rpcCalls: string[] = [];
    const spy = {
      from: inner.from.bind(inner),
      rpc: async (name: string, args: { payload: Record<string, unknown> }) => {
        rpcCalls.push(name);
        return inner.rpc(name, args);
      },
    } as unknown as SupabaseClient;
    const second = await drainOutboxFully(spy, undefined, USER);

    expect(second.success).toBe(true);
    expect(rpcCalls).toEqual([]); // 辨識為已完成，不再呼叫 RPC
    expect(listOutboxEntries()).toHaveLength(0);
    expect(db.tables.review_attempts.rows).toHaveLength(1);
    expect(db.tables.review_attempts.rows[0].id).toBe(graded.attempt.id);
    expect(cloudSchedule(db)).toEqual(scheduleAfterFirst);
  });

  it("4. session_id + exercise_id 已存在且逐欄相同：冪等完成，不再改動雲端", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const { sessionId, exerciseId, graded } = answer(newRepository(), "correct", T1);
    db.tables.review_attempts.rows.push({
      id: graded.attempt.id, user_id: USER, session_id: sessionId, sequence_in_session: 0, exercise_id: exerciseId,
      learning_item_id: CLOUD_ITEM, language: "ja", exercise_type: "recall", result: "correct", used_hint: false,
      response_time_ms: 500, reviewed_at: T1,
    });
    const scheduleBefore = { ...cloudSchedule(db) };

    const outcome = await rebaseScheduleConflict(asClient(createFakeSupabaseClient(db)), USER, firstOf("record_graded_attempt"));

    expect(outcome).toEqual({ kind: "already_applied" });
    expect(db.tables.review_attempts.rows).toHaveLength(1);
    expect(cloudSchedule(db)).toEqual(scheduleBefore);
    expect(readRebaseJournal(USER)).toHaveLength(0);
  });

  it("5. session_id + exercise_id 已存在但內容不同：保留衝突，不寫入", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const { sessionId, exerciseId, graded } = answer(newRepository(), "correct", T1);
    db.tables.review_attempts.rows.push({
      id: graded.attempt.id, user_id: USER, session_id: sessionId, sequence_in_session: 0, exercise_id: exerciseId,
      learning_item_id: CLOUD_ITEM, language: "ja", exercise_type: "recall", result: "incorrect", used_hint: false,
      response_time_ms: 500, reviewed_at: T1,
    });
    const scheduleBefore = { ...cloudSchedule(db) };
    const before = comparableOutbox();

    const outcome = await rebaseScheduleConflict(asClient(createFakeSupabaseClient(db)), USER, firstOf("record_graded_attempt"));

    expect(outcome).toEqual({ kind: "refused", reason: "attempt_differs" });
    expect(cloudSchedule(db)).toEqual(scheduleBefore);
    expect(comparableOutbox()).toEqual(before);
  });

  it("6a. 重放期間另一裝置更新 schedule：CAS 拒絕後重新讀取、重算，不關 CAS", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    answer(newRepository(), "correct", T1);

    const inner = createFakeSupabaseClient(db);
    let recordCalls = 0;
    const racing = {
      from: inner.from.bind(inner),
      rpc: async (name: string, args: { payload: Record<string, unknown> }) => {
        if (name === "record_graded_attempt") {
          recordCalls += 1;
          if (recordCalls === 2) {
            // 第一次重放送出前，另一裝置剛好推進了同一個排程（較作答時間早，仍可重放）。
            Object.assign(cloudSchedule(db)!, {
              due_at: "2026-01-13T00:00:00.000Z", interval_days: 7, streak: 3, lapse_count: 1,
              last_reviewed_at: "2026-01-10T00:01:00.000Z",
            });
          }
        }
        return inner.rpc(name, args);
      },
    } as unknown as SupabaseClient;

    const outcome = await drainOutboxFully(racing, undefined, USER);

    expect(outcome.success).toBe(true);
    expect(recordCalls).toBe(3); // 原始（衝突）→ 第一次重放（CAS 拒絕）→ 第二次重放（成功）
    const expectedNext = computeNextSchedule({ streak: 3, lapseCount: 1 }, "correct", new Date(T1));
    expect(cloudSchedule(db)).toMatchObject({ streak: 4, due_at: expectedNext.dueAt, last_reviewed_at: T1 });
    expect(db.tables.review_attempts.rows).toHaveLength(1);
    expect(readRebaseJournal(USER)).toHaveLength(2);
  });

  it("6b. 另一裝置的雲端進度比這筆作答更新：拒絕，不把舊作答倒放在新進度之上", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db, { schedule: { ...CLOUD_SCHEDULE, last_reviewed_at: "2026-01-10T01:00:00.000Z" } });
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    answer(newRepository(), "correct", T1);
    const before = comparableOutbox();

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("attempt_not_newer_than_cloud");
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(cloudSchedule(db)).toMatchObject({ streak: 2, last_reviewed_at: "2026-01-10T01:00:00.000Z" });
    expect(comparableOutbox()).toEqual(before.slice(1)); // upsert_session 已送出，作答 entry 原封不動
  });

  it("7a. 沒有 alias：拒絕", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal({ id: CLOUD_ITEM }); // 本機 ID 與雲端相同（無 alias），才會真的走到 schedule_changed
    answer(newRepository(), "correct", T1, CLOUD_ITEM);

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("no_alias");
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(listOutboxEntries().map((entry) => entry.type)).toEqual(["record_graded_attempt"]);
  });

  it("7b. 欄位不相容：拒絕", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db, { explanation: "雲端說明" });
    writeLocal({ explanation: "本機說明" });
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    answer(newRepository(), "correct", T1);

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("fields_incompatible");
    expect(db.tables.review_attempts.rows).toHaveLength(0);
  });

  it("7c. 雙端都有未合併進度（本機作答前已有自己的排程、無 journal 可證明）：拒絕", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal({ withSchedule: true });
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const repository = newRepository();
    const session = repository.getOrCreateInProgressSession("ja", [{ learningItemId: LOCAL_ITEM, ability: "recall", kind: "review" }], new Date(T1));
    repository.recordGradedAttempt({
      sessionId: session.id, learningItemId: LOCAL_ITEM, ability: "recall", exerciseId: "exercise_both",
      exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 500, now: new Date(T1),
    });

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("unproven_expected_schedule");
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(cloudSchedule(db)).toMatchObject({ streak: 2 });
  });

  it("8. mark_attempt_correct：由重放 journal 與雲端作答列反查 item／能力，從重放前位置重算 correct", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const repository = newRepository();
    const { sessionId, exerciseId } = answer(repository, "incorrect", T1);
    repository.markAttemptCorrect({ sessionId, exerciseId });
    const mark = firstOf("mark_attempt_correct");
    expect("learning_item_id" in mark.payload).toBe(false); // payload 本來就不含 item id

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(outcome.success).toBe(true);
    const expectedNext = computeNextSchedule({ streak: 2, lapseCount: 1 }, "correct", new Date(T1));
    expect(cloudSchedule(db)).toMatchObject({
      streak: 3, lapse_count: 1, interval_days: expectedNext.intervalDays, due_at: expectedNext.dueAt, last_reviewed_at: T1,
    });
    expect(db.tables.review_attempts.rows[0]).toMatchObject({ learning_item_id: CLOUD_ITEM, result: "correct" });
    expect(readRebaseJournal(USER).map((entry) => entry.kind)).toEqual(["record_graded_attempt", "mark_attempt_correct"]);
    expect(listOutboxEntries()).toHaveLength(0);
  });

  it("8b. mark_attempt_correct 沒有對應的重放紀錄：拒絕，不猜測", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    const repository = newRepository();
    const { sessionId, exerciseId } = answer(repository, "incorrect", T1);
    repository.markAttemptCorrect({ sessionId, exerciseId });

    const outcome = await rebaseScheduleConflict(asClient(createFakeSupabaseClient(db)), USER, firstOf("mark_attempt_correct"));

    expect(outcome).toEqual({ kind: "refused", reason: "no_rebase_record_for_correction" });
    expect(db.tables.review_attempts.rows).toHaveLength(0);
  });

  it("9. 本機 storage 寫入 journal 失敗：原 outbox 完整保留、雲端不變；恢復後可重試", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    writeLocal();
    commitItemAlias(USER, LOCAL_ITEM, CLOUD_ITEM, ALIAS_AT);
    answer(newRepository(), "correct", T1);
    const original = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if (key.includes("rebase-journal")) throw new DOMException("quota", "QuotaExceededError");
      original(key, value);
    };

    const failed = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);

    expect(failed.success).toBe(false);
    expect(failed.message).toContain("journal_write_failed");
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(cloudSchedule(db)).toMatchObject({ streak: 2, last_reviewed_at: CLOUD_SCHEDULE.last_reviewed_at });
    const head = listOutboxEntries()[0];
    expect(head.type).toBe("record_graded_attempt");
    if (head.type !== "record_graded_attempt") throw new Error("unexpected");
    expect(head.payload.expected_schedule).toBeNull(); // 原始 payload 未被改寫

    storage.setItem = original;
    const retried = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, USER);
    expect(retried.success).toBe(true);
    expect(db.tables.review_attempts.rows).toHaveLength(1);
  });

  it("10. 跨帳戶：別的帳戶沒有 alias／journal，不會套用重放；其 pending 不被刪除", async () => {
    const db = new FakeSupabaseDatabase();
    seedCloud(db);
    seedCloud(db, { id: "item_shared" });
    writeLocal({ id: "item_shared" });
    commitItemAlias(USER, "item_shared", CLOUD_ITEM); // 只有 USER 有這個 alias
    answer(newRepository(), "correct", T1, "item_shared");
    enqueueOutboxEntry({ type: "upsert_preferences", payload: { user_id: OTHER, daily_question_count: 10, daily_new_item_cap: 30 } });
    const before = comparableOutbox();

    const outcome = await drainOutboxFully(asClient(createFakeSupabaseClient(db)), undefined, OTHER);

    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("no_alias");
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(cloudSchedule(db)).toMatchObject({ streak: 2 });
    expect(db.tables.schedule_states.rows.find((row) => row.learning_item_id === "item_shared")).toMatchObject({ streak: 2 });
    expect(readRebaseJournal(OTHER)).toHaveLength(0);
    expect(readRebaseJournal(USER)).toHaveLength(0);
    // 已送出的 upsert_session 之外，作答與其他帳戶的偏好 entry 全部保留。
    expect(comparableOutbox()).toEqual(before.slice(1));
  });
});

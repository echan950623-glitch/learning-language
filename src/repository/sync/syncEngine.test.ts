import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage, type MemoryStorage } from "../../test/localStorageMock";
import { createEmptyStore, readPersistedStore, writePersistedStore, type PersistedStore } from "../schema";
import { __clearOutboxForTests, enqueueOutboxEntries, listOutboxEntries, type LearningItemRow, type OutboxOperation } from "./outbox";
import { drainOutboxFully, __resetSyncEngineForTests } from "./syncEngine";
import { createFakeSupabaseClient, FakeSupabaseDatabase, type FakeSupabaseClient } from "./testSupabaseFake";
import { commitItemAlias, loadAliasStore } from "./alias";

function asClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

function itemRow(overrides: Partial<LearningItemRow> = {}): LearningItemRow {
  return {
    id: "item_local",
    user_id: "user_1",
    language: "ja",
    type: "vocabulary",
    prompt_zh: "狗",
    answer: "犬",
    reading: "いぬ",
    explanation: null,
    romaji: null,
    part_of_speech: null,
    example_sentence: null,
    source: "manual",
    tags: [],
    status: "new",
    created_at: "2026-01-01T00:00:00.000Z",
    is_seed: false,
    ...overrides,
  };
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
});

describe("drainOutboxFully：content-key 衝突 remap", () => {
  it("跨裝置相同單字、不同 id：不再卡住 outbox，其餘操作 remap 後正常送出", async () => {
    const db = new FakeSupabaseDatabase();
    // 遠端已經有裝置 A 同步過的這個單字（不同 id，相同 content_key）。
    db.tables.learning_items.rows.push({
      ...itemRow({ id: "item_remote_winner", status: "learning" }),
      content_key: "ja|vocabulary|狗|犬|いぬ",
    });
    const client = createFakeSupabaseClient(db);

    // 本機（裝置 B）持久化 store：同一個單字，不同 id，還帶了排程／作答／session。
    const localStore: PersistedStore = {
      schemaVersion: 2,
      items: [
        {
          id: "item_local",
          language: "ja",
          type: "vocabulary",
          promptZh: "狗",
          answer: "犬",
          reading: "いぬ",
          source: "manual",
          tags: ["常用"],
          status: "new",
          createdAt: "2026-01-02T00:00:00.000Z",
          isSeed: false,
        },
      ],
      scheduleStates: [
        {
          learningItemId: "item_local",
          ability: "recall",
          language: "ja",
          dueAt: "2026-01-10T00:00:00.000Z",
          intervalDays: 3,
          streak: 2,
          lapseCount: 0,
          lastReviewedAt: "2026-01-08T00:00:00.000Z",
        },
      ],
      reviewAttempts: [
        {
          id: "attempt_local_1",
          exerciseId: "ex_1",
          learningItemId: "item_local",
          language: "ja",
          exerciseType: "recall",
          sessionId: "session_local_1",
          result: "correct",
          usedHint: false,
          responseTimeMs: 800,
          reviewedAt: "2026-01-08T00:00:00.000Z",
        },
      ],
      studySessions: [
        {
          id: "session_local_1",
          language: "ja",
          status: "completed",
          startedAt: "2026-01-08T00:00:00.000Z",
          completedAt: "2026-01-08T00:05:00.000Z",
          plannedUnits: [{ learningItemId: "item_local", ability: "recall", kind: "new" }],
          exerciseResults: [
            { exerciseId: "ex_1", learningItemId: "item_local", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 800 },
          ],
          newItemIds: ["item_local"],
          reviewItemIds: [],
        },
      ],
    };
    writePersistedStore(localStore);

    const operations: OutboxOperation[] = [
      { type: "upsert_item", payload: itemRow({ id: "item_local", status: "new", tags: ["常用"] }) },
      {
        type: "upsert_session",
        payload: {
          id: "session_local_1",
          user_id: "user_1",
          language: "ja",
          status: "completed",
          started_at: "2026-01-08T00:00:00.000Z",
          completed_at: "2026-01-08T00:05:00.000Z",
          planned_units: [{ learningItemId: "item_local", ability: "recall", kind: "new" }],
          new_item_ids: ["item_local"],
          review_item_ids: [],
        },
      },
      {
        type: "upsert_schedule_state",
        payload: {
          user_id: "user_1",
          learning_item_id: "item_local",
          ability: "recall",
          language: "ja",
          due_at: "2026-01-10T00:00:00.000Z",
          interval_days: 3,
          streak: 2,
          lapse_count: 0,
          last_reviewed_at: "2026-01-08T00:00:00.000Z",
        },
      },
      {
        type: "upsert_review_attempt",
        payload: {
          id: "attempt_local_1",
          user_id: "user_1",
          session_id: "session_local_1",
          sequence_in_session: 0,
          exercise_id: "ex_1",
          learning_item_id: "item_local",
          language: "ja",
          exercise_type: "recall",
          result: "correct",
          used_hint: false,
          response_time_ms: 800,
          reviewed_at: "2026-01-08T00:00:00.000Z",
        },
      },
    ];
    enqueueOutboxEntries(operations);

    const outcome = await drainOutboxFully(asClient(client));

    expect(outcome.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    // learning_items 仍然只有一筆（沒有因為裝置 B 而多出一筆重複的單字）。
    expect(db.tables.learning_items.rows).toHaveLength(1);
    expect(db.tables.learning_items.rows[0].id).toBe("item_remote_winner");
    // tags 有聯集（遠端原本沒有 tags，本機的「常用」補進去）。
    expect(db.tables.learning_items.rows[0].tags).toEqual(["常用"]);
    // status 遠端已經是 'learning'（有進度），不會被本機的 'new' 蓋掉。
    expect(db.tables.learning_items.rows[0].status).toBe("learning");

    // schedule_states／review_attempts／study_sessions 都落在贏家 id 底下，沒有遺失。
    expect(db.tables.schedule_states.rows).toHaveLength(1);
    expect(db.tables.schedule_states.rows[0].learning_item_id).toBe("item_remote_winner");
    expect(db.tables.review_attempts.rows).toHaveLength(1);
    expect(db.tables.review_attempts.rows[0].learning_item_id).toBe("item_remote_winner");
    expect(db.tables.study_sessions.rows).toHaveLength(1);
    expect((db.tables.study_sessions.rows[0].planned_units as Array<{ learningItemId: string }>)[0].learningItemId).toBe(
      "item_remote_winner"
    );

    // 本機 store 保持原始 ID；持久化 alias 只在網路邊界轉成 canonical ID。
    const rewritten = readPersistedStore();
    expect(rewritten.items).toHaveLength(1);
    expect(rewritten.items[0].id).toBe("item_local");
    expect(rewritten.scheduleStates[0].learningItemId).toBe("item_local");
    expect(rewritten.reviewAttempts[0].learningItemId).toBe("item_local");
    expect(rewritten.studySessions[0].plannedUnits[0].learningItemId).toBe("item_local");
    expect(loadAliasStore("user_1").items).toContainEqual(expect.objectContaining({ localId: "item_local", canonicalId: "item_remote_winner" }));
  });

  it("一筆衝突不會卡住佇列裡其他完全不相關的單字", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }), content_key: "ja|vocabulary|狗|犬|いぬ" });
    const client = createFakeSupabaseClient(db);
    writePersistedStore(createEmptyStore());

    enqueueOutboxEntries([
      { type: "upsert_item", payload: itemRow({ id: "loser" }) }, // 會衝突
      { type: "upsert_item", payload: itemRow({ id: "unrelated", prompt_zh: "貓", answer: "猫", reading: "ねこ" }) }, // 完全不相關
    ]);

    const outcome = await drainOutboxFully(asClient(client));
    expect(outcome.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    expect(db.tables.learning_items.rows.map((r) => r.id).sort()).toEqual(["unrelated", "winner"]);
  });

  it("遠端排程比較新：不被本機比較舊的排程覆蓋", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }), content_key: "ja|vocabulary|狗|犬|いぬ" });
    db.tables.schedule_states.rows.push({
      user_id: "user_1",
      learning_item_id: "winner",
      ability: "recall",
      language: "ja",
      due_at: "2026-02-01T00:00:00.000Z",
      interval_days: 30,
      streak: 10,
      lapse_count: 0,
      last_reviewed_at: "2026-01-25T00:00:00.000Z",
    });
    const client = createFakeSupabaseClient(db);
    writePersistedStore(createEmptyStore());

    enqueueOutboxEntries([
      { type: "upsert_item", payload: itemRow({ id: "loser" }) },
      {
        type: "upsert_schedule_state",
        payload: {
          user_id: "user_1",
          learning_item_id: "loser",
          ability: "recall",
          language: "ja",
          due_at: "2026-01-06T00:00:00.000Z",
          interval_days: 1,
          streak: 0,
          lapse_count: 0,
          last_reviewed_at: "2026-01-05T00:00:00.000Z",
        },
      },
    ]);

    const outcome = await drainOutboxFully(asClient(client));
    expect(outcome.success).toBe(false);
    expect(listOutboxEntries()).toHaveLength(2);
    expect(db.tables.schedule_states.rows).toHaveLength(1);
    expect(db.tables.schedule_states.rows[0]).toMatchObject({ interval_days: 30, streak: 10 });
  });

  it("本機排程看似較新時也不臆測合併：保留雙方並停止", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }), content_key: "ja|vocabulary|狗|犬|いぬ" });
    db.tables.schedule_states.rows.push({
      user_id: "user_1",
      learning_item_id: "winner",
      ability: "recall",
      language: "ja",
      due_at: "2026-01-06T00:00:00.000Z",
      interval_days: 1,
      streak: 0,
      lapse_count: 0,
      last_reviewed_at: "2026-01-05T00:00:00.000Z",
    });
    const client = createFakeSupabaseClient(db);
    writePersistedStore(createEmptyStore());

    enqueueOutboxEntries([
      { type: "upsert_item", payload: itemRow({ id: "loser" }) },
      {
        type: "upsert_schedule_state",
        payload: {
          user_id: "user_1",
          learning_item_id: "loser",
          ability: "recall",
          language: "ja",
          due_at: "2026-02-01T00:00:00.000Z",
          interval_days: 30,
          streak: 10,
          lapse_count: 0,
          last_reviewed_at: "2026-01-25T00:00:00.000Z",
        },
      },
    ]);

    const outcome = await drainOutboxFully(asClient(client));
    expect(outcome.success).toBe(false);
    expect(listOutboxEntries()).toHaveLength(2);
    expect(db.tables.schedule_states.rows).toHaveLength(1);
    expect(db.tables.schedule_states.rows[0]).toMatchObject({ interval_days: 1, streak: 0 });
  });

  it("remap 之後接續的 record_graded_attempt RPC（一般流程，不是 migration）也能正確落地", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }), content_key: "ja|vocabulary|狗|犬|いぬ" });
    db.tables.study_sessions.rows.push({
      id: "session_1",
      user_id: "user_1",
      language: "ja",
      status: "in_progress",
      started_at: "2026-01-08T00:00:00.000Z",
      completed_at: null,
      planned_units: [{ learningItemId: "loser", ability: "recall", kind: "new" }],
      new_item_ids: ["loser"],
      review_item_ids: [],
    });
    const client = createFakeSupabaseClient(db);
    writePersistedStore(createEmptyStore());

    enqueueOutboxEntries([
      { type: "upsert_item", payload: itemRow({ id: "loser" }) },
      {
        type: "record_graded_attempt",
        payload: {
          attempt_id: "attempt_1",
          session_id: "session_1",
          learning_item_id: "loser",
          ability: "recall",
          exercise_id: "ex_1",
          exercise_type: "recall",
          result: "correct",
          used_hint: false,
          response_time_ms: 500,
          reviewed_at: "2026-01-08T00:05:00.000Z",
          expected_schedule: null,
          schedule: { due_at: "2026-01-09T00:00:00.000Z", interval_days: 1, streak: 1, lapse_count: 0 },
          item_status: "learning",
          session_completed: true,
          session_completed_at: "2026-01-08T00:05:00.000Z",
        },
      },
    ]);

    // study_sessions.planned_units 裡的 'loser' 也要能被 upsert_session 型別以外的方式
    // remap 到——這裡故意不送 upsert_session（模擬 session 是遠端已經存在、本機只是
    // 補送這一題的作答），驗證 record_graded_attempt 本身的 learning_item_id 有被 remap。
    const outcome = await drainOutboxFully(asClient(client));
    expect(outcome.success).toBe(true);
    expect(db.tables.review_attempts.rows).toHaveLength(1);
    expect(db.tables.review_attempts.rows[0].learning_item_id).toBe("winner");
  });

  it("一般作答送出前排程已被另一裝置更新時，拒絕覆蓋並保留 outbox", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "item_1" }) });
    db.tables.study_sessions.rows.push({
      id: "session_1", user_id: "user_1", language: "ja", status: "in_progress",
      started_at: "2026-01-08T00:00:00.000Z", completed_at: null,
      planned_units: [{ learningItemId: "item_1", ability: "recall", kind: "review" }],
      new_item_ids: [], review_item_ids: ["item_1"],
    });
    db.tables.schedule_states.rows.push({
      user_id: "user_1", learning_item_id: "item_1", ability: "recall", language: "ja",
      due_at: "2026-02-01T00:00:00.000Z", interval_days: 30, streak: 8, lapse_count: 0,
      last_reviewed_at: "2026-01-25T00:00:00.000Z",
    });
    const client = createFakeSupabaseClient(db);
    enqueueOutboxEntries([{
      type: "record_graded_attempt",
      payload: {
        attempt_id: "attempt_local", session_id: "session_1", learning_item_id: "item_1",
        ability: "recall", exercise_id: "ex_1", exercise_type: "recall", result: "correct",
        used_hint: false, response_time_ms: 500, reviewed_at: "2026-01-10T00:00:00.000Z",
        expected_schedule: { due_at: "2026-01-09T00:00:00.000Z", interval_days: 1, streak: 1, lapse_count: 0, last_reviewed_at: "2026-01-08T00:00:00.000Z" },
        schedule: { due_at: "2026-01-12T00:00:00.000Z", interval_days: 3, streak: 2, lapse_count: 0 },
        item_status: "learning", session_completed: true, session_completed_at: "2026-01-10T00:00:00.000Z",
      },
    }]);

    const outcome = await drainOutboxFully(asClient(client));
    expect(outcome.success).toBe(false);
    expect(listOutboxEntries()).toHaveLength(1);
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(db.tables.schedule_states.rows[0]).toMatchObject({ interval_days: 30, streak: 8 });
  });
});

describe("drainOutboxFully：中斷安全／可重試", () => {
  it("重新載入後 migration 以 userId 讀回既有 alias，剩餘操作仍送到 canonical ID", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }) });
    const client = createFakeSupabaseClient(db);
    commitItemAlias("user_1", "loser", "winner");
    enqueueOutboxEntries([{
      type: "upsert_schedule_state",
      payload: {
        user_id: "user_1", learning_item_id: "loser", ability: "recall", language: "ja",
        due_at: "2026-01-09T00:00:00.000Z", interval_days: 1, streak: 1, lapse_count: 0,
        last_reviewed_at: "2026-01-08T00:00:00.000Z",
      },
    }]);

    const outcome = await drainOutboxFully(asClient(client), undefined, "user_1");
    expect(outcome.success).toBe(true);
    expect(db.tables.schedule_states.rows[0].learning_item_id).toBe("winner");
  });

  it("持久化失敗（setItem 拋出）時，衝突原封不動留在佇列最前面，之後可以直接重試", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }), content_key: "ja|vocabulary|狗|犬|いぬ" });
    const client = createFakeSupabaseClient(db);
    writePersistedStore({
      schemaVersion: 2,
      items: [
        {
          id: "loser",
          language: "ja",
          type: "vocabulary",
          promptZh: "狗",
          answer: "犬",
          reading: "いぬ",
          source: "manual",
          tags: [],
          status: "new",
          createdAt: "2026-01-01T00:00:00.000Z",
          isSeed: false,
        },
      ],
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [],
    });

    enqueueOutboxEntries([{ type: "upsert_item", payload: itemRow({ id: "loser" }) }]);

    // 下一次 setItem（也就是 resolveContentKeyConflict 改寫本機 store 那一步）會失敗。
    storage.failNextSetItem(1);

    const failedOutcome = await drainOutboxFully(asClient(client));
    expect(failedOutcome.success).toBe(false);

    // 衝突那筆還在佇列最前面，沒有被誤刪；本機 store 也還沒被改寫成一半的狀態。
    const entriesAfterFailure = listOutboxEntries();
    expect(entriesAfterFailure).toHaveLength(1);
    expect(entriesAfterFailure[0].type).toBe("upsert_item");
    const storeAfterFailure = readPersistedStore();
    expect(storeAfterFailure.items[0]?.id).toBe("loser");

    // 停止模擬失敗，直接重試：應該完整成功，不需要任何額外處理。
    storage.stopFailing();
    const retryOutcome = await drainOutboxFully(asClient(client));
    expect(retryOutcome.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    expect(readPersistedStore().items[0]?.id).toBe("loser");
    expect(loadAliasStore("user_1").items).toContainEqual(expect.objectContaining({ localId: "loser", canonicalId: "winner" }));
  });

  it("outbox 改寫本身失敗（setOutboxEntries 拋出）時，不會假裝解決成功、留下卡住的殘局", async () => {
    // 刻意讓本機 store 空白（remap 這步是 no-op，changed:false），單獨隔離出「outbox
    // 改寫」這一步的失敗——這是這次順手修掉的既有 bug：`setOutboxEntries` 原本底層用
    // 會吞例外的 `writeOutboxEntries`，寫入失敗時呼叫端完全不知道，會誤以為衝突已經
    // 解決而回報 advanced，但 outbox 其實還是舊的、卡住的那筆，之後每次重試都會用一樣
    // 的輸入重新撞同一個唯一鍵，永遠卡在原地。
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }), content_key: "ja|vocabulary|狗|犬|いぬ" });
    const client = createFakeSupabaseClient(db);
    writePersistedStore(createEmptyStore());

    enqueueOutboxEntries([{ type: "upsert_item", payload: itemRow({ id: "loser" }) }]);

    storage.failNextSetItem(1);
    const failedOutcome = await drainOutboxFully(asClient(client));
    expect(failedOutcome.success).toBe(false);

    // 衝突那筆必須還在佇列裡（不能被誤判成已解決），下次可以直接重試。
    expect(listOutboxEntries()).toHaveLength(1);

    storage.stopFailing();
    const retryOutcome = await drainOutboxFully(asClient(client));
    expect(retryOutcome.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
  });

  it("模擬『本機 store 已經改寫過、但 outbox 還沒改寫』的中斷狀態：重試後仍然收斂到正確結果", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({ ...itemRow({ id: "winner" }), content_key: "ja|vocabulary|狗|犬|いぬ" });
    const client = createFakeSupabaseClient(db);

    // 模擬第一次 resolveContentKeyConflict 已經完成「改寫本機 store」，但在改寫 outbox
    // 之前就被中斷（例如瀏覽器在這個時間點被關掉）：本機 store 已經是 winner id，
    // 但 outbox 裡引用 loser 的操作都還沒被 remap。
    writePersistedStore({
      schemaVersion: 2,
      items: [
        {
          id: "winner",
          language: "ja",
          type: "vocabulary",
          promptZh: "狗",
          answer: "犬",
          reading: "いぬ",
          source: "manual",
          tags: [],
          status: "new",
          createdAt: "2026-01-01T00:00:00.000Z",
          isSeed: false,
        },
      ],
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [],
    });
    enqueueOutboxEntries([
      { type: "upsert_item", payload: itemRow({ id: "loser" }) },
      {
        type: "upsert_schedule_state",
        payload: {
          user_id: "user_1",
          learning_item_id: "loser",
          ability: "recall",
          language: "ja",
          due_at: "2026-01-10T00:00:00.000Z",
          interval_days: 3,
          streak: 1,
          lapse_count: 0,
          last_reviewed_at: "2026-01-08T00:00:00.000Z",
        },
      },
    ]);

    const outcome = await drainOutboxFully(asClient(client));
    expect(outcome.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    expect(db.tables.schedule_states.rows[0]?.learning_item_id).toBe("winner");
    expect(readPersistedStore().items).toHaveLength(1);
  });
});

describe("drainOutboxFully：migration 與背景 kick() 不會同時操作同一個 outbox", () => {
  it("兩個並發呼叫序列化執行，不會互相踩到對方讀到一半的佇列", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    // 用 any 包一層純測試用的插樁（追蹤「同一時間有幾個 query 真的在飛」），刻意不跟
    // FakeQueryBuilder.then 的 generic 簽章糾纏——這裡只是計數器，不是型別安全需要顧及的
    // production 邏輯。
    let inFlight = 0;
    let maxInFlight = 0;
    const originalRpc = client.rpc.bind(client);
    client.rpc = async (name, args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      try {
        return await originalRpc(name, args);
      } finally {
        inFlight -= 1;
      }
    };

    writePersistedStore(createEmptyStore());
    enqueueOutboxEntries([
      { type: "upsert_item", payload: itemRow({ id: "a", prompt_zh: "一", answer: "一", reading: null }) },
      { type: "upsert_item", payload: itemRow({ id: "b", prompt_zh: "二", answer: "二", reading: null }) },
      { type: "upsert_item", payload: itemRow({ id: "c", prompt_zh: "三", answer: "三", reading: null }) },
      { type: "upsert_item", payload: itemRow({ id: "d", prompt_zh: "四", answer: "四", reading: null }) },
    ]);

    const [first, second] = await Promise.all([drainOutboxFully(asClient(client)), drainOutboxFully(asClient(client))]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    expect(db.tables.learning_items.rows).toHaveLength(4);
    // 最重要的保證：任何時刻最多只有一個 query 真正在飛，兩個 drainOutboxFully 呼叫
    // 沒有交錯讀寫同一個 outbox。
    expect(maxInFlight).toBe(1);
  });
});

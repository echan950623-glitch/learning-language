import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage, type MemoryStorage } from "../../test/localStorageMock";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { readPersistedStore, writePersistedStore, type PersistedStore } from "../schema";
import { __clearOutboxForTests, listOutboxEntries } from "./outbox";
import { __resetSyncEngineForTests } from "./syncEngine";
import {
  __resetMigrationForTests,
  __verifyMigrationForTests,
  isMigrationCompleted,
  runInitialMigration,
  sameJson,
} from "./migration";
import { createFakeSupabaseClient, FakeSupabaseDatabase, type FakeSupabaseClient } from "./testSupabaseFake";

function asClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

const USER_ID = "user_1";

function contentKey(row: { language: string; type: string; prompt_zh: string; answer: string; reading: string | null }): string {
  return [row.language, row.type, row.prompt_zh, row.answer, row.reading ?? ""].join("|");
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
  __resetMigrationForTests();
});

describe("migration JSONB comparison", () => {
  it("忽略 JSON 物件鍵順序，但保留陣列順序語意", () => {
    expect(
      sameJson(
        [{ learningItemId: "item-1", ability: "recall", kind: "review" }],
        [{ ability: "recall", kind: "review", learningItemId: "item-1" }]
      )
    ).toBe(true);
    expect(sameJson([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }])).toBe(false);
  });

  it("把 Z 與等價的 UTC offset 時間視為同一瞬間，仍拒絕真正不同的時間", () => {
    expect(
      sameJson(
        { due_at: "2026-09-20T00:00:00.000Z", last_reviewed_at: "2026-09-19T08:00:00.000Z" },
        { last_reviewed_at: "2026-09-19T16:00:00+08:00", due_at: "2026-09-20T00:00:00+00:00" }
      )
    ).toBe(true);
    expect(sameJson({ reviewed_at: "2026-09-19T08:00:00Z" }, { reviewed_at: "2026-09-19T08:00:01Z" })).toBe(false);
  });
});

describe("runInitialMigration：跨裝置重複單字＋雙方已有作答", () => {
  it("無法證明可無損合併時保留雙方資料與完整 outbox，回報待處理衝突", async () => {
    const db = new FakeSupabaseDatabase();

    // 裝置 A 早就同步過：同一個單字（不同 id）、自己的 session／作答／排程（比較新）。
    db.tables.learning_items.rows.push({
      id: "item_remote_dog",
      user_id: USER_ID,
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
      tags: ["N5"],
      status: "learning",
      created_at: "2026-01-01T00:00:00.000Z",
      is_seed: false,
      content_key: "ja|vocabulary|狗|犬|いぬ",
    });
    db.tables.study_sessions.rows.push({
      id: "session_remote",
      user_id: USER_ID,
      language: "ja",
      status: "completed",
      started_at: "2026-01-20T00:00:00.000Z",
      completed_at: "2026-01-20T00:05:00.000Z",
      planned_units: [{ learningItemId: "item_remote_dog", ability: "recall", kind: "new" }],
      new_item_ids: ["item_remote_dog"],
      review_item_ids: [],
    });
    db.tables.review_attempts.rows.push({
      id: "attempt_remote_1",
      user_id: USER_ID,
      session_id: "session_remote",
      sequence_in_session: 0,
      exercise_id: "ex_remote_1",
      learning_item_id: "item_remote_dog",
      language: "ja",
      exercise_type: "recall",
      result: "correct",
      used_hint: false,
      response_time_ms: 900,
      reviewed_at: "2026-01-20T00:05:00.000Z",
    });
    db.tables.schedule_states.rows.push({
      user_id: USER_ID,
      learning_item_id: "item_remote_dog",
      ability: "recall",
      language: "ja",
      due_at: "2026-02-19T00:00:00.000Z",
      interval_days: 30,
      streak: 5,
      lapse_count: 0,
      last_reviewed_at: "2026-01-20T00:05:00.000Z",
    });

    const client = createFakeSupabaseClient(db);

    // 裝置 B（這台，還沒同步過）：同一個單字、不同 id，自己也已經有作答／排程（比較舊），
    // 外加一個完全不相關的單字，證明「不衝突的項目照常一起遷移」。
    const localStore: PersistedStore = {
      schemaVersion: 2,
      items: [
        {
          id: "item_local_dog",
          language: "ja",
          type: "vocabulary",
          promptZh: "狗",
          answer: "犬",
          reading: "いぬ",
          source: "manual",
          tags: ["常用"],
          status: "learning",
          createdAt: "2026-01-05T00:00:00.000Z",
          isSeed: false,
        },
        {
          id: "item_local_cat",
          language: "ja",
          type: "vocabulary",
          promptZh: "貓",
          answer: "猫",
          reading: "ねこ",
          source: "manual",
          tags: [],
          status: "new",
          createdAt: "2026-01-05T00:00:00.000Z",
          isSeed: false,
        },
      ],
      scheduleStates: [
        {
          learningItemId: "item_local_dog",
          ability: "recall",
          language: "ja",
          dueAt: "2026-01-12T00:00:00.000Z",
          intervalDays: 3,
          streak: 2,
          lapseCount: 0,
          lastReviewedAt: "2026-01-09T00:00:00.000Z",
        },
      ],
      reviewAttempts: [
        {
          id: "attempt_local_1",
          exerciseId: "ex_local_1",
          learningItemId: "item_local_dog",
          language: "ja",
          exerciseType: "recall",
          sessionId: "session_local",
          result: "correct",
          usedHint: false,
          responseTimeMs: 700,
          reviewedAt: "2026-01-09T00:00:00.000Z",
        },
      ],
      studySessions: [
        {
          id: "session_local",
          language: "ja",
          status: "completed",
          startedAt: "2026-01-09T00:00:00.000Z",
          completedAt: "2026-01-09T00:05:00.000Z",
          plannedUnits: [{ learningItemId: "item_local_dog", ability: "recall", kind: "new" }],
          exerciseResults: [
            { exerciseId: "ex_local_1", learningItemId: "item_local_dog", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 700 },
          ],
          newItemIds: ["item_local_dog"],
          reviewItemIds: [],
        },
      ],
    };
    writePersistedStore(localStore);

    const repository = new LocalStorageLearningRepository();
    const status = await runInitialMigration({ repository, supabase: asClient(client), userId: USER_ID });

    expect(status.phase).toBe("partial_failure");
    expect(isMigrationCompleted(USER_ID)).toBe(false);

    // FIFO 停在第一筆衝突；遠端原有資料完全不變，也不跳過去製造看似成功的「貓」。
    expect(db.tables.learning_items.rows).toHaveLength(1);
    const dogRow = db.tables.learning_items.rows.find((r) => r.id === "item_remote_dog");
    expect(dogRow).toBeDefined();
    expect(dogRow!.tags).toEqual(["N5"]);

    // 遠端作答與排程未被本機較舊資料覆蓋。
    const dogAttempts = db.tables.review_attempts.rows.filter((r) => r.learning_item_id === "item_remote_dog");
    expect(dogAttempts.map((a) => a.id)).toEqual(["attempt_remote_1"]);

    // 排程用「比較新」的那筆（裝置 A 的），不會被裝置 B 比較舊的排程蓋掉。
    const dogSchedule = db.tables.schedule_states.rows.find((r) => r.learning_item_id === "item_remote_dog");
    expect(dogSchedule).toMatchObject({ interval_days: 30, streak: 5 });

    // 本機原始 ID、作答與後續所有待送操作均保留，可在之後人工決定合併方式。
    const preserved = readPersistedStore();
    expect(preserved.items.find((i) => i.answer === "犬")?.id).toBe("item_local_dog");
    expect(preserved.reviewAttempts.find((a) => a.id === "attempt_local_1")?.learningItemId).toBe("item_local_dog");
    expect(listOutboxEntries()).toHaveLength(6);
  });
});

describe("runInitialMigration：部分上傳後重試", () => {
  it("中途一筆暫時性失敗會停在 partial_failure；重試後完整完成、不重複", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    // 讓第一次呼叫（第一筆 upsert_item）模擬離線失敗一次，其餘照常。
    let shouldFailOnce = true;
    const originalRpc = client.rpc.bind(client);
    client.rpc = async (name, args) => {
      if (name === "upsert_learning_item_guarded" && shouldFailOnce) {
        shouldFailOnce = false;
        return { data: null, error: { message: "network down" }, status: 0 };
      }
      return originalRpc(name, args);
    };

    writePersistedStore({
      schemaVersion: 2,
      items: [
        {
          id: "item_a",
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

    const repository = new LocalStorageLearningRepository();
    const firstAttempt = await runInitialMigration({ repository, supabase: asClient(client), userId: USER_ID });

    expect(firstAttempt.phase).toBe("partial_failure");
    expect(isMigrationCompleted(USER_ID)).toBe(false);
    expect(db.tables.learning_items.rows).toHaveLength(0);
    // outbox 裡失敗那筆連同之後的都還留著，不會憑空消失。
    expect(listOutboxEntries().length).toBeGreaterThan(0);

    const retry = await runInitialMigration({ repository, supabase: asClient(client), userId: USER_ID });
    expect(retry.phase).toBe("completed");
    expect(listOutboxEntries()).toHaveLength(0);
    // 重試是安全的 upsert，不會把同一個項目重複插入兩筆。
    expect(db.tables.learning_items.rows).toHaveLength(1);
    expect(isMigrationCompleted(USER_ID)).toBe(true);
  });

  it("alias 已提交、後續操作中斷後重新整理重試，重複 enqueue 仍可收斂", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({
      id: "item_remote", user_id: USER_ID, language: "ja", type: "vocabulary", prompt_zh: "狗",
      answer: "犬", reading: "いぬ", explanation: null, romaji: null, part_of_speech: null,
      example_sentence: null, source: "manual", tags: [], status: "new",
      created_at: "2026-01-01T00:00:00.000Z", is_seed: false, content_key: "ja|vocabulary|狗|犬|いぬ",
    });
    const client = createFakeSupabaseClient(db);
    const originalRpc = client.rpc.bind(client);
    let failScheduleOnce = true;
    client.rpc = async (name, args) => {
      if (name === "upsert_schedule_state_guarded" && failScheduleOnce) {
        failScheduleOnce = false;
        return { data: null, error: { message: "network down" }, status: 0 };
      }
      return originalRpc(name, args);
    };
    writePersistedStore({
      schemaVersion: 2,
      items: [{
        id: "item_local", language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬",
        reading: "いぬ", source: "manual", tags: [], status: "learning",
        createdAt: "2026-01-05T00:00:00.000Z", isSeed: false,
      }],
      scheduleStates: [{
        learningItemId: "item_local", ability: "recall", language: "ja", dueAt: "2026-01-10T00:00:00.000Z",
        intervalDays: 3, streak: 2, lapseCount: 0, lastReviewedAt: "2026-01-07T00:00:00.000Z",
      }],
      reviewAttempts: [], studySessions: [],
    });

    const repository = new LocalStorageLearningRepository();
    const first = await runInitialMigration({ repository, supabase: asClient(client), userId: USER_ID });
    expect(first.phase).toBe("partial_failure");
    __resetMigrationForTests(); // 模擬頁面重新整理後模組狀態重建，localStorage/journal 保留。
    __resetSyncEngineForTests();

    const retry = await runInitialMigration({
      repository: new LocalStorageLearningRepository(), supabase: asClient(client), userId: USER_ID,
    });
    expect(retry.phase).toBe("completed");
    expect(listOutboxEntries()).toHaveLength(0);
    expect(db.tables.learning_items.rows).toHaveLength(1);
    expect(db.tables.schedule_states.rows[0]).toMatchObject({ learning_item_id: "item_remote", interval_days: 3, streak: 2 });
    expect(readPersistedStore().items[0].id).toBe("item_local");
  });
});

describe("runInitialMigration：持久化失敗", () => {
  it("content-key 衝突 remap 途中 localStorage 寫入失敗：回報 partial_failure，本機資料保留，重試可恢復", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({
      id: "item_remote",
      user_id: USER_ID,
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
      content_key: "ja|vocabulary|狗|犬|いぬ",
    });
    const client = createFakeSupabaseClient(db);

    writePersistedStore({
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

    const repository = new LocalStorageLearningRepository();

    // migration 一開始會先做一次「遷移前備份」（也是 setItem），所以直接鎖定
    // resolveContentKeyConflict 改寫本機 store 那一步：backup 完、enqueue 完之後才
    // 讓下一次 setItem 失敗。用 failSetItemAlways 確保不管前面實際發生幾次 setItem，
    // 從這裡開始全部失敗，藉此觀察「drain 遇到寫入失敗」的行為，而不用精算次數。
    storage.failSetItemAlways();
    const failed = await runInitialMigration({ repository, supabase: asClient(client), userId: USER_ID });

    expect(failed.phase === "partial_failure" || failed.phase === "error").toBe(true);
    expect(isMigrationCompleted(USER_ID)).toBe(false);
    // 遠端沒有因為半套的 remap 而產生錯誤的第二筆。
    expect(db.tables.learning_items.rows).toHaveLength(1);

    storage.stopFailing();
    const retry = await runInitialMigration({ repository, supabase: asClient(client), userId: USER_ID });
    expect(retry.phase).toBe("completed");
    expect(db.tables.learning_items.rows).toHaveLength(1);
    expect(isMigrationCompleted(USER_ID)).toBe(true);
  });
});

describe("verifyMigration：核對實際紀錄與關聯，不是只比總數", () => {
  it("總數對得上，但實際關聯（learning_item_id）錯誤時，判定失敗並指出是哪一筆", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    // 遠端剛好有「跟本機一樣多」的 review_attempts，但關聯到錯的 learning_item_id——
    // 只比總數的舊版核對邏輯會誤判成功，新的逐筆核對必須抓出來。
    db.tables.review_attempts.rows.push({
      id: "attempt_1",
      user_id: USER_ID,
      session_id: "session_1",
      sequence_in_session: 0,
      exercise_id: "ex_1",
      learning_item_id: "item_WRONG",
      language: "ja",
      exercise_type: "recall",
      result: "correct",
      used_hint: false,
      response_time_ms: 100,
      reviewed_at: "2026-01-01T00:00:00.000Z",
    });

    writePersistedStore({
      schemaVersion: 2,
      // reviewAttempts 必須對應到存在、語言一致的 LearningItem，否則 sanitizeStore 會在
      // 讀回來的時候先丟掉這筆（見 schema.ts 的 finalizeStore）——放這筆項目只是為了讓
      // 測試資料通過那層驗證，不是這個測試要驗證的重點。
      items: [
        {
          id: "item_correct",
          language: "ja",
          type: "vocabulary",
          promptZh: "狗",
          answer: "犬",
          source: "manual",
          tags: [],
          status: "new",
          createdAt: "2026-01-01T00:00:00.000Z",
          isSeed: false,
        },
      ],
      scheduleStates: [],
      reviewAttempts: [
        {
          id: "attempt_1",
          exerciseId: "ex_1",
          learningItemId: "item_correct",
          language: "ja",
          exerciseType: "recall",
          sessionId: "session_1",
          result: "correct",
          usedHint: false,
          responseTimeMs: 100,
          reviewedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      studySessions: [],
    });

    const categories = await __verifyMigrationForTests(asClient(client), USER_ID);
    const attemptsCategory = categories.find((c) => c.key === "reviewAttempts")!;
    expect(attemptsCategory.localCount).toBe(1);
    expect(attemptsCategory.remoteCount).toBe(1);
    expect(attemptsCategory.ok).toBe(false);
    expect(attemptsCategory.mismatchedIds).toEqual(["attempt_1"]);
  });

  it("session 引用的 learningItemId 在遠端不存在時，即使 session 本身存在也判定失敗", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    db.tables.study_sessions.rows.push({
      id: "session_1",
      user_id: USER_ID,
      language: "ja",
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:05:00.000Z",
      planned_units: [{ learningItemId: "item_missing", ability: "recall", kind: "new" }],
      new_item_ids: ["item_missing"],
      review_item_ids: [],
    });
    // 注意：learning_items 表故意不放 item_missing，模擬斷鏈。

    writePersistedStore({
      schemaVersion: 2,
      // items 故意留空：completed session 允許引用「之後被移除」的項目（見 schema.ts
      // finalizeStore 的註解，只有 in_progress 才強制要求項目仍存在），這裡就是要驗證
      // 這種「歷史合法、但遠端關聯斷鏈」的狀況會被抓出來，不是因為本機資料本身壞掉。
      items: [],
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [
        {
          id: "session_1",
          language: "ja",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:05:00.000Z",
          plannedUnits: [{ learningItemId: "item_missing", ability: "recall", kind: "new" }],
          // completed session 必須「題目都做完」（exerciseResults.length === plannedUnits.length），
          // 否則 isStudySession 會判定自相矛盾、整筆丟棄，見 schema.ts。
          exerciseResults: [
            { exerciseId: "ex_1", learningItemId: "item_missing", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 100 },
          ],
          newItemIds: ["item_missing"],
          reviewItemIds: [],
        },
      ],
    });

    const categories = await __verifyMigrationForTests(asClient(client), USER_ID);
    const sessionsCategory = categories.find((c) => c.key === "studySessions")!;
    expect(sessionsCategory.ok).toBe(false);
    expect(sessionsCategory.mismatchedIds).toEqual(["session_1"]);
  });
});

// contentKey 只在本檔用來讓測試資料的敘述更清楚（跟 db 種子資料的 content_key 對得上），
// 避免每筆手key 常數字串時打錯。
void contentKey;

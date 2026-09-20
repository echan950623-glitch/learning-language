import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage } from "../../test/localStorageMock";
import { initializeStudySession } from "../../app/study/sessionInit";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { readPersistedStore, writePersistedStore } from "../schema";
import { SyncingLearningRepository } from "../syncingRepository";
import { __clearOutboxForTests, enqueueOutboxEntry, learningItemToRow, listOutboxEntries } from "./outbox";
import {
  __resetSyncEngineForTests,
  configureSyncEngine,
  drainOutboxFully,
  getSyncStatus,
  pullAndMergeRemoteData,
} from "./syncEngine";
import { loadAliasStore } from "./alias";
import { buildTodayQueue } from "../../domain/queue";
import { createFakeSupabaseClient, FakeSupabaseDatabase } from "./testSupabaseFake";

const USER = "user_1";

beforeEach(() => {
  installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
});

describe("本機缺少雲端已有的 schedule → sync_conflict:schedule_changed（伺服器 CAS 保護維持 fail closed）", () => {
  it("本機把已有雲端進度的項目排成 new，作答後 outbox 停在 schedule_changed 且不覆蓋雲端", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({
      id: "item_1", user_id: USER, language: "ja", type: "vocabulary", prompt_zh: "狗", answer: "犬",
      reading: "いぬ", explanation: null, romaji: null, part_of_speech: null, example_sentence: null,
      source: "manual", tags: [], status: "learning", created_at: "2026-01-01T00:00:00.000Z", is_seed: false,
      content_key: "ja|vocabulary|狗|犬|いぬ",
    });
    // 雲端已有這個項目 recall 的進度（遷移時寫入）。
    db.tables.schedule_states.rows.push({
      user_id: USER, learning_item_id: "item_1", ability: "recall", language: "ja",
      due_at: "2026-01-05T00:00:00.000Z", interval_days: 3, streak: 2, lapse_count: 0,
      last_reviewed_at: "2026-01-02T00:00:00.000Z",
    });
    const client = createFakeSupabaseClient(db) as unknown as SupabaseClient;

    // 本機 store：同一個項目，但沒有任何 schedule／attempt（status new）。
    writePersistedStore({
      schemaVersion: 2,
      items: [{
        id: "item_1", language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬",
        reading: "いぬ", source: "manual", tags: [], status: "new",
        createdAt: "2026-01-01T00:00:00.000Z", isSeed: false,
      }],
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [],
    });

    const repository = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER);
    const init = initializeStudySession(repository, new Date("2026-01-06T00:00:00.000Z"), 10, 10);
    if (init.phase !== "active") throw new Error(`unexpected phase ${init.phase}`);
    // 規劃器把它當成「新字」——這正是雲端 session 出現 new_item_ids 全是舊項目的原因。
    expect(init.session.plannedUnits).toEqual([{ learningItemId: "item_1", ability: "recall", kind: "new" }]);

    repository.recordGradedAttempt({
      sessionId: init.session.id, learningItemId: "item_1", ability: "recall", exerciseId: "ex_1",
      exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 500,
      now: new Date("2026-01-06T00:05:00.000Z"),
    });

    const graded = listOutboxEntries().find((entry) => entry.type === "record_graded_attempt");
    expect(graded?.type === "record_graded_attempt" && graded.payload.expected_schedule).toBeNull();

    const outcome = await drainOutboxFully(client, undefined, USER);
    expect(outcome.success).toBe(false);
    // 沒有 canonical alias：無損重放拒絕，訊息保留原始錯誤並附上拒絕原因。
    expect(outcome.message).toContain("sync_conflict:schedule_changed");
    expect(outcome.message).toContain("no_alias");
    // FIFO 首筆（作答）與其後所有操作都留著，且不會自己解開。
    expect(listOutboxEntries()[0].type).toBe("record_graded_attempt");
    const again = await drainOutboxFully(client, undefined, USER);
    expect(again.message).toContain("no_alias");
    expect(db.tables.review_attempts.rows).toHaveLength(0);
  });
});

describe("alias 建立後重新拉取雲端資料：空白副本不再被排成新字", () => {
  it("同內容不同 ID 的本機空白副本 alias 後，回呼觸發 pull，取得雲端 schedule，規劃器不再排 new", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({
      id: "item_cloud", user_id: USER, language: "ja", type: "vocabulary", prompt_zh: "狗", answer: "犬",
      reading: "いぬ", explanation: null, romaji: null, part_of_speech: null, example_sentence: null,
      source: "manual", tags: [], status: "learning", created_at: "2026-01-01T00:00:00.000Z", is_seed: false,
      content_key: "ja|vocabulary|狗|犬|いぬ",
    });
    db.tables.schedule_states.rows.push({
      user_id: USER, learning_item_id: "item_cloud", ability: "recall", language: "ja",
      due_at: "2026-01-09T00:00:00.000Z", interval_days: 3, streak: 2, lapse_count: 0,
      last_reviewed_at: "2026-01-06T00:00:00.000Z",
    });
    const client = createFakeSupabaseClient(db) as unknown as SupabaseClient;

    // 本機只有一份沒有任何進度的同內容副本（不同 ID）。
    const localItem = {
      id: "item_local", language: "ja" as const, type: "vocabulary" as const, promptZh: "狗", answer: "犬",
      reading: "いぬ", source: "manual" as const, tags: [], status: "new" as const,
      createdAt: "2026-01-02T00:00:00.000Z", isSeed: false,
    };
    writePersistedStore({ schemaVersion: 2, items: [localItem], scheduleStates: [], reviewAttempts: [], studySessions: [] });
    enqueueOutboxEntry({ type: "upsert_item", payload: learningItemToRow(localItem, USER) });

    let refreshed = 0;
    let refreshDone: Promise<void> = Promise.resolve();
    configureSyncEngine({
      supabase: client,
      userId: USER,
      onAliasCommitted: () => {
        refreshed += 1;
        refreshDone = pullAndMergeRemoteData(client, USER);
      },
    });
    await vi.waitFor(() => expect(getSyncStatus().pendingCount).toBe(0));
    await vi.waitFor(() => expect(refreshed).toBe(1));
    await refreshDone;

    expect(loadAliasStore(USER).items).toEqual([expect.objectContaining({ localId: "item_local", canonicalId: "item_cloud" })]);
    const store = readPersistedStore();
    const local = store.items.find((item) => item.id === "item_local");
    expect(local?.status).toBe("learning");
    expect(store.scheduleStates).toEqual([expect.objectContaining({ learningItemId: "item_local", ability: "recall", streak: 2 })]);

    // 2026-01-07：recall 尚未到期，不再被當成新字（否則作答會帶 expected_schedule=null 撞上雲端既有排程）。
    // reading 雲端本來就沒有排程，作為「補齊能力」的 new 是正確的，且 expected_schedule=null 與雲端一致。
    const queue = buildTodayQueue(store.items, store.scheduleStates, new Date("2026-01-07T00:00:00.000Z"), 10);
    expect(queue.reviewUnits).toHaveLength(0);
    expect(queue.newUnits.map((unit) => unit.ability)).toEqual(["reading"]);
  });

  it("沒有建立別名的一般 drain 不會觸發重新拉取", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db) as unknown as SupabaseClient;
    const localItem = {
      id: "item_plain", language: "ja" as const, type: "vocabulary" as const, promptZh: "貓", answer: "猫",
      reading: "ねこ", source: "manual" as const, tags: [], status: "new" as const,
      createdAt: "2026-01-02T00:00:00.000Z", isSeed: false,
    };
    writePersistedStore({ schemaVersion: 2, items: [localItem], scheduleStates: [], reviewAttempts: [], studySessions: [] });
    enqueueOutboxEntry({ type: "upsert_item", payload: learningItemToRow(localItem, USER) });

    let refreshed = 0;
    configureSyncEngine({ supabase: client, userId: USER, onAliasCommitted: () => { refreshed += 1; } });
    await vi.waitFor(() => expect(getSyncStatus().phase).toBe("idle"));
    await vi.waitFor(() => expect(db.tables.learning_items.rows).toHaveLength(1));
    expect(getSyncStatus().pendingCount).toBe(0);
    expect(refreshed).toBe(0);
    expect(loadAliasStore(USER).items).toEqual([]);
  });

  it("A 帳戶待通知的 alias 不會誤觸 B 帳戶重新拉取，A 再登入時仍會收到", async () => {
    const db = new FakeSupabaseDatabase();
    db.tables.learning_items.rows.push({
      id: "item_cloud", user_id: USER, language: "ja", type: "vocabulary", prompt_zh: "狗", answer: "犬",
      reading: "いぬ", explanation: null, romaji: null, part_of_speech: null, example_sentence: null,
      source: "manual", tags: [], status: "new", created_at: "2026-01-01T00:00:00.000Z", is_seed: false,
      content_key: "ja|vocabulary|狗|犬|いぬ",
    });
    const client = createFakeSupabaseClient(db) as unknown as SupabaseClient;
    const localItem = {
      id: "item_local", language: "ja" as const, type: "vocabulary" as const, promptZh: "狗", answer: "犬",
      reading: "いぬ", source: "manual" as const, tags: [], status: "new" as const,
      createdAt: "2026-01-02T00:00:00.000Z", isSeed: false,
    };
    writePersistedStore({ schemaVersion: 2, items: [localItem], scheduleStates: [], reviewAttempts: [], studySessions: [] });
    enqueueOutboxEntry({ type: "upsert_item", payload: learningItemToRow(localItem, USER) });

    expect((await drainOutboxFully(client, undefined, USER)).success).toBe(true);
    let userBRefreshes = 0;
    configureSyncEngine({ supabase: client, userId: "user_2", onAliasCommitted: () => { userBRefreshes += 1; } });
    await vi.waitFor(() => expect(getSyncStatus().phase).toBe("idle"));
    expect(userBRefreshes).toBe(0);

    let userARefreshes = 0;
    configureSyncEngine({ supabase: client, userId: USER, onAliasCommitted: () => { userARefreshes += 1; } });
    await vi.waitFor(() => expect(userARefreshes).toBe(1));
  });
});

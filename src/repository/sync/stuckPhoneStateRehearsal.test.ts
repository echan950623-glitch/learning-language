/**
 * 手機卡住資料的隔離演練（用 2026-09-20 診斷畫面上的真實識別碼重建，不碰任何真實帳號）。
 *
 * 已知狀態：pendingCount=3、全部是 record_graded_attempt、head 是
 * session_9aa7fab5-…／exercise_c22cf3ed-…／localItemId item_658a0474-… 已有別名指向
 * canonical item_30b8c344-…／ability=recall／expectedSchedule=null／
 * localSchedule streak=1、intervalDays=1／localItemStatus=learning。
 *
 * 雲端那台 canonical item 有沒有 recall 排程，本機無從得知，所以兩種狀態都演練：
 * - 沒有排程：補上 session 後三筆直接落地。
 * - 已有排程：補上 session 後會撞上 CAS（sync_conflict:schedule_changed），由既有的
 *   無損重放接手，仍然不覆蓋雲端既有進度。
 * 另外演練「outbox 待送筆數少於本機已作答筆數」這種不完整狀態，必須拒絕並完整保留。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage } from "../../test/localStorageMock";
import { readPersistedStore, writePersistedStore, SCHEMA_VERSION, type PersistedStore } from "../schema";
import { commitItemAlias, __clearAliasStoreForTests } from "./alias";
import { __clearOutboxForTests, enqueueOutboxEntries, listOutboxEntries, setOutboxEntries, type OutboxOperation } from "./outbox";
import { __resetSyncEngineForTests, drainOutboxFully } from "./syncEngine";
import { __clearRebaseJournalForTests } from "./scheduleRebase";
import { createFakeSupabaseClient, FakeSupabaseDatabase, type FakeSupabaseClient } from "./testSupabaseFake";

const USER_ID = "user_phone_rehearsal";
const SESSION_ID = "session_9aa7fab5-6050-4115-be7c-098f1099905a";
const EXERCISE_ID = "exercise_c22cf3ed-ccaf-4755-b8a8-20cc918e98aa";
const LOCAL_ITEM_ID = "item_658a0474-b656-410a-bae8-e03863833a35";
const CANONICAL_ITEM_ID = "item_30b8c344-79ef-49bf-8c5b-32eac2c4838c";
const OTHER_ITEM_IDS = ["item_rehearsal_2", "item_rehearsal_3"];
const REVIEWED_AT = "2026-09-20T17:22:52.344Z";
const DUE_AT = "2026-09-21T17:22:52.344Z";

function asClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

function localItem(id: string, marker: string) {
  return {
    id,
    language: "ja" as const,
    type: "vocabulary" as const,
    promptZh: `演練-${marker}`,
    answer: `テスト-${marker}`,
    reading: undefined,
    source: "manual" as const,
    tags: [] as string[],
    status: "learning" as const,
    createdAt: "2026-09-19T00:00:00.000Z",
    isSeed: false,
  };
}

function cloudItemRow(id: string, marker: string) {
  return {
    id,
    user_id: USER_ID,
    language: "ja",
    type: "vocabulary",
    prompt_zh: `演練-${marker}`,
    answer: `テスト-${marker}`,
    reading: null,
    explanation: null,
    romaji: null,
    part_of_speech: null,
    example_sentence: null,
    source: "manual",
    tags: [],
    status: "learning",
    created_at: "2026-09-19T00:00:00.000Z",
    is_seed: false,
    content_key: `ja|vocabulary|演練-${marker}|テスト-${marker}|`,
  };
}

/** 三題（recall）的 session，全部答完、session 已 completed，本機資料完整。 */
function buildLocalStore(): PersistedStore {
  const itemIds = [LOCAL_ITEM_ID, ...OTHER_ITEM_IDS];
  const exerciseIds = [EXERCISE_ID, "exercise_rehearsal_2", "exercise_rehearsal_3"];
  return {
    schemaVersion: SCHEMA_VERSION,
    items: itemIds.map((id, index) => localItem(id, String(index + 1))),
    scheduleStates: itemIds.map((id) => ({
      learningItemId: id,
      ability: "recall" as const,
      language: "ja" as const,
      dueAt: DUE_AT,
      intervalDays: 1,
      streak: 1,
      lapseCount: 0,
      lastReviewedAt: REVIEWED_AT,
    })),
    reviewAttempts: itemIds.map((id, index) => ({
      id: `attempt_rehearsal_${index + 1}`,
      exerciseId: exerciseIds[index],
      learningItemId: id,
      language: "ja" as const,
      exerciseType: "recall" as const,
      sessionId: SESSION_ID,
      result: "correct" as const,
      usedHint: false,
      responseTimeMs: 1500,
      reviewedAt: REVIEWED_AT,
    })),
    studySessions: [
      {
        id: SESSION_ID,
        language: "ja",
        status: "completed",
        startedAt: "2026-09-20T17:22:00.000Z",
        completedAt: REVIEWED_AT,
        plannedUnits: itemIds.map((id) => ({ learningItemId: id, ability: "recall" as const, kind: "new" as const })),
        exerciseResults: itemIds.map((id, index) => ({
          exerciseId: exerciseIds[index],
          learningItemId: id,
          exerciseType: "recall" as const,
          result: "correct" as const,
          usedHint: false,
          responseTimeMs: 1500,
        })),
        newItemIds: itemIds,
        reviewItemIds: [],
      },
    ],
  };
}

function pendingAttempts(): OutboxOperation[] {
  const store = buildLocalStore();
  const session = store.studySessions[0];
  return session.exerciseResults.map((result, index) => ({
    type: "record_graded_attempt",
    payload: {
      attempt_id: store.reviewAttempts[index].id,
      session_id: SESSION_ID,
      learning_item_id: result.learningItemId,
      ability: "recall",
      exercise_id: result.exerciseId,
      exercise_type: "recall",
      result: "correct",
      used_hint: false,
      response_time_ms: 1500,
      reviewed_at: REVIEWED_AT,
      expected_schedule: null,
      schedule: { due_at: DUE_AT, interval_days: 1, streak: 1, lapse_count: 0 },
      item_status: "learning",
      session_completed: index === session.exerciseResults.length - 1,
      session_completed_at: index === session.exerciseResults.length - 1 ? REVIEWED_AT : null,
    },
  }));
}

/** 雲端：canonical item＋另外兩個 item 都已存在；session 不存在（這就是卡住的原因）。 */
function buildCloudDatabase(): FakeSupabaseDatabase {
  const db = new FakeSupabaseDatabase();
  db.tables.learning_items.rows.push(cloudItemRow(CANONICAL_ITEM_ID, "1"));
  OTHER_ITEM_IDS.forEach((id, index) => db.tables.learning_items.rows.push(cloudItemRow(id, String(index + 2))));
  return db;
}

beforeEach(() => {
  installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
  __clearAliasStoreForTests(USER_ID);
  __clearRebaseJournalForTests(USER_ID);
  writePersistedStore(buildLocalStore());
  commitItemAlias(USER_ID, LOCAL_ITEM_ID, CANONICAL_ITEM_ID);
  enqueueOutboxEntries(pendingAttempts());
});

describe("手機卡住資料的隔離演練", () => {
  it("雲端 canonical item 尚無 recall 排程：補上 session 後三筆依序落地，本機資料不變", async () => {
    const db = buildCloudDatabase();
    const client = createFakeSupabaseClient(db);
    const localBefore = JSON.stringify(readPersistedStore());

    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);

    expect(drain.message ?? "").toBe("");
    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    const session = db.tables.study_sessions.rows.find((row) => row.id === SESSION_ID);
    expect(session?.status).toBe("completed");
    expect(session?.completed_at).toBe(REVIEWED_AT);
    // 送出邊界會把本機 id 換成 canonical id，本機 store 的 id 不變。
    expect(session?.planned_units).toEqual([
      { learningItemId: CANONICAL_ITEM_ID, ability: "recall", kind: "new" },
      { learningItemId: OTHER_ITEM_IDS[0], ability: "recall", kind: "new" },
      { learningItemId: OTHER_ITEM_IDS[1], ability: "recall", kind: "new" },
    ]);

    const attempts = db.tables.review_attempts.rows.filter((row) => row.session_id === SESSION_ID);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((row) => row.sequence_in_session)).toEqual([0, 1, 2]);
    expect(attempts[0].learning_item_id).toBe(CANONICAL_ITEM_ID);
    expect(attempts[0].exercise_id).toBe(EXERCISE_ID);

    const canonicalSchedule = db.tables.schedule_states.rows.find(
      (row) => row.learning_item_id === CANONICAL_ITEM_ID && row.ability === "recall"
    );
    expect(canonicalSchedule).toMatchObject({ due_at: DUE_AT, interval_days: 1, streak: 1, lapse_count: 0 });
    expect(JSON.stringify(readPersistedStore())).toBe(localBefore);
  });

  it("雲端 canonical item 已有較新 recall 排程：不覆蓋，由無損重放以雲端為基準重算", async () => {
    const db = buildCloudDatabase();
    db.tables.schedule_states.rows.push({
      user_id: USER_ID,
      learning_item_id: CANONICAL_ITEM_ID,
      ability: "recall",
      language: "ja",
      due_at: "2026-09-25T00:00:00.000Z",
      interval_days: 3,
      streak: 2,
      lapse_count: 0,
      last_reviewed_at: "2026-09-19T00:00:00.000Z",
    });
    const client = createFakeSupabaseClient(db);

    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);

    expect(drain.message ?? "").toBe("");
    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    expect(db.tables.study_sessions.rows.find((row) => row.id === SESSION_ID)?.status).toBe("completed");

    const attempts = db.tables.review_attempts.rows.filter((row) => row.session_id === SESSION_ID);
    expect(attempts).toHaveLength(3);

    // 重放是以雲端既有排程為基準往前推，不是把本機的 streak=1 蓋回去。
    const canonicalSchedule = db.tables.schedule_states.rows.find(
      (row) => row.learning_item_id === CANONICAL_ITEM_ID && row.ability === "recall"
    );
    expect(canonicalSchedule?.streak).toBe(3);
    expect(canonicalSchedule?.last_reviewed_at).toBe(REVIEWED_AT);
  });

  it("outbox 待送筆數少於本機已作答筆數：拒絕補送，資料與佇列完整保留", async () => {
    const db = buildCloudDatabase();
    const client = createFakeSupabaseClient(db);
    // 模擬「前面幾筆作答從來沒有進過 outbox」的不完整狀態。
    setOutboxEntries(listOutboxEntries().slice(1));
    const localBefore = JSON.stringify(readPersistedStore());

    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);

    expect(drain.success).toBe(false);
    expect(drain.message).toContain("pending_attempt_count_mismatch");
    expect(listOutboxEntries()).toHaveLength(2);
    expect(db.tables.study_sessions.rows).toHaveLength(0);
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(JSON.stringify(readPersistedStore())).toBe(localBefore);
  });
});

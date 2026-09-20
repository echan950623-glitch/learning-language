/**
 * 重現「答完第 1 題後第 2 題被舊畫面守門擋住、重新載入又變成全新 session」。
 *
 * 依 2026-09-21 雲端唯讀證據重建：
 * - 雲端有多筆 in_progress session，每筆題目順序相同、各自只有 1 筆作答。
 * - 每一筆的第 1 題都是同一個已有別名的項目（本機 id L ↔ canonical C），而且被排成
 *   「新內容」——代表本機沒有這個能力的排程，作答會帶 expected_schedule = null。
 * - 雲端那個項目其實早就有排程（streak 大、到期日在一個月後）。
 *
 * 所以第 1 題送出必然撞上 CAS → 無損重放 → 重放成功後觸發 pull-merge，重寫本機 store。
 * 這個測試把那一整段跑完，然後用 `/study` 送出前的同一個核對函式判斷第 2 題能不能送出。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage } from "../../test/localStorageMock";
import { createEmptyStore, readPersistedStore, writePersistedStore, SCHEMA_VERSION, type PersistedStore } from "../schema";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { SyncingLearningRepository } from "../syncingRepository";
import { initializeStudySession, isAttemptSubmissionCurrent } from "../../app/study/sessionInit";
import { buildExerciseForUnit } from "../../domain/exercises";
import type { LearningItem, StudySession } from "../../domain/types";
import { commitItemAlias, __clearAliasStoreForTests } from "./alias";
import { __clearOutboxForTests, listOutboxEntries } from "./outbox";
import { __clearRebaseJournalForTests } from "./scheduleRebase";
import { __resetSyncEngineForTests, drainOutboxFully, pullAndMergeRemoteData } from "./syncEngine";
import { createFakeSupabaseClient, FakeSupabaseDatabase, type FakeSupabaseClient } from "./testSupabaseFake";

const USER_ID = "user_stuck";
const LOCAL_GREETING = "item_local_greeting";
const CANONICAL_GREETING = "item_cloud_greeting";
const SECOND_ITEM = "item_person";
const THIRD_ITEM = "item_japan";

function asClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

function item(id: string, promptZh: string, answer: string): LearningItem {
  return {
    id,
    language: "ja",
    type: "vocabulary",
    promptZh,
    answer,
    source: "manual",
    tags: [],
    status: "new",
    createdAt: "2026-09-15T13:41:49.328Z",
    isSeed: false,
  };
}

function cloudItemRow(source: LearningItem, id: string, status: string) {
  return {
    id,
    user_id: USER_ID,
    language: "ja",
    type: "vocabulary",
    prompt_zh: source.promptZh,
    answer: source.answer,
    reading: null,
    explanation: null,
    romaji: null,
    part_of_speech: null,
    example_sentence: null,
    source: "manual",
    tags: [],
    status,
    created_at: source.createdAt,
    is_seed: false,
    content_key: `ja|vocabulary|${source.promptZh}|${source.answer}|`,
  };
}

/** 本機：三個項目，第一個已有別名但沒有排程（所以會被排成「新內容」）。 */
function buildLocalStore(): PersistedStore {
  const store = createEmptyStore();
  store.items.push(
    item(LOCAL_GREETING, "你好", "こんにちは"),
    item(SECOND_ITEM, "人", "ひと"),
    item(THIRD_ITEM, "日本", "にほん")
  );
  return { ...store, schemaVersion: SCHEMA_VERSION };
}

/** 雲端：canonical 項目早就有排程，另外兩個沒有。 */
function buildCloudDatabase(): FakeSupabaseDatabase {
  const db = new FakeSupabaseDatabase();
  const local = buildLocalStore();
  db.tables.learning_items.rows.push(cloudItemRow(local.items[0], CANONICAL_GREETING, "mastered"));
  db.tables.learning_items.rows.push(cloudItemRow(local.items[1], SECOND_ITEM, "new"));
  db.tables.learning_items.rows.push(cloudItemRow(local.items[2], THIRD_ITEM, "new"));
  db.tables.schedule_states.rows.push({
    user_id: USER_ID,
    learning_item_id: CANONICAL_GREETING,
    ability: "recall",
    language: "ja",
    due_at: "2026-10-20T18:03:57.319Z",
    interval_days: 30,
    streak: 13,
    lapse_count: 1,
    last_reviewed_at: "2026-09-20T18:03:57.319Z",
  });
  return db;
}

function answerCurrentQuestion(
  repository: SyncingLearningRepository,
  session: StudySession,
  index: number,
  now: Date
): void {
  const unit = session.plannedUnits[index];
  const learningItem = repository.getItem(unit.learningItemId);
  if (!learningItem) throw new Error(`測試資料異常：找不到 ${unit.learningItemId}`);
  const exercise = buildExerciseForUnit(learningItem, unit.ability);
  repository.recordGradedAttempt({
    sessionId: session.id,
    learningItemId: unit.learningItemId,
    ability: unit.ability,
    exerciseId: exercise.id,
    exerciseType: exercise.exerciseType,
    result: "correct",
    usedHint: false,
    responseTimeMs: 1200,
    now,
  });
}

beforeEach(() => {
  installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
  __clearAliasStoreForTests(USER_ID);
  __clearRebaseJournalForTests(USER_ID);
  writePersistedStore(buildLocalStore());
  commitItemAlias(USER_ID, LOCAL_GREETING, CANONICAL_GREETING);
});

describe("答完第 1 題之後還能不能繼續作答", () => {
  it("第 1 題是已有別名、本機無排程的項目：答完後第 2 題仍必須可以送出", async () => {
    const db = buildCloudDatabase();
    const client = createFakeSupabaseClient(db);

    // 啟動時的 pull-merge（登入後 refreshFromRemote 會做的事）。
    await pullAndMergeRemoteData(asClient(client), USER_ID);

    const repository = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER_ID);
    const init = initializeStudySession(repository, new Date("2026-09-20T18:03:54.044Z"));
    if (init.phase !== "active") throw new Error(`預期 active，實際是 ${init.phase}`);
    const session = init.session;
    expect(session.plannedUnits.length).toBeGreaterThan(1);

    // 第 1 題送出。
    answerCurrentQuestion(repository, session, 0, new Date("2026-09-20T18:03:57.319Z"));
    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);
    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    // 重放成功會通知呼叫端重新拉取（onAliasCommitted → refreshFromRemote）。
    await pullAndMergeRemoteData(asClient(client), USER_ID);

    // `/study` 送出第 2 題之前做的同一個核對。
    const latest = new LocalStorageLearningRepository()
      .listStudySessions({ language: "ja", status: "all" })
      .find((candidate) => candidate.id === session.id);
    const nextUnit = session.plannedUnits[1];

    expect(latest, "本機 store 不應該在同步之後弄丟這筆進行中的 session").toBeDefined();
    expect(
      isAttemptSubmissionCurrent({
        session: latest,
        currentIndex: 1,
        learningItemId: nextUnit.learningItemId,
        ability: nextUnit.ability,
      }),
      "第 2 題應該可以正常送出，不該被舊畫面守門擋下"
    ).toBe(true);
  });

  it("第 1 題完成後，本機應該拿到雲端那筆排程，下一輪不再把同一個項目當成新內容", async () => {
    const db = buildCloudDatabase();
    const client = createFakeSupabaseClient(db);

    await pullAndMergeRemoteData(asClient(client), USER_ID);
    const store = readPersistedStore();
    const greetingSchedule = store.scheduleStates.find(
      (schedule) => schedule.learningItemId === LOCAL_GREETING && schedule.ability === "recall"
    );

    expect(greetingSchedule, "雲端 canonical 排程應該翻譯回本機 id 並保留下來").toBeDefined();
    expect(greetingSchedule?.streak).toBe(13);
  });
});

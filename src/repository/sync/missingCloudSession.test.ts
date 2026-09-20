/**
 * 重現並鎖住「作答引用的 session 從未上傳到雲端」這個同步死結。
 *
 * 症狀（2026-09-20 手機 PWA 診斷）：outbox 只剩 record_graded_attempt，head 一直失敗在
 * `record_graded_attempt: session "session_..." 不存在`，attempts 持續累加，FIFO 首筆
 * 永遠卡住，後面所有待送操作一起停擺。
 *
 * 這裡不 mock 任何錯誤訊息：整條路徑都走真的元件——
 * `LocalStorageLearningRepository` → `SyncingLearningRepository` → outbox（localStorage）
 * → `drainOutboxFully` → 假 Supabase 的 `record_graded_attempt` RPC（該 RPC 跟真實
 * SQL 一樣：session 不存在就 raise），錯誤是真的從 RPC 邊界冒出來的。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage } from "../../test/localStorageMock";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { SyncingLearningRepository } from "../syncingRepository";
import { initializeStudySession } from "../../app/study/sessionInit";
import { buildExerciseForUnit } from "../../domain/exercises";
import type { LearningItem, StudySession } from "../../domain/types";
import type { LearningRepository } from "../types";
import { __clearOutboxForTests, learningItemToRow, listOutboxEntries, setOutboxEntries } from "./outbox";
import { drainOutboxFully, __resetSyncEngineForTests } from "./syncEngine";
import { createFakeSupabaseClient, FakeSupabaseDatabase, type FakeSupabaseClient } from "./testSupabaseFake";

const USER_ID = "user_phone";

function asClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

/**
 * 冷啟動競態的第一段：分頁載入時 `AuthSyncBootstrapper` 的 `supabase.auth.getSession()`
 * 還沒 resolve，`getRepository()` 回傳的是純本機 repository（沒有 outbox）。
 * 這時候 `/study` 的初始化 effect 已經建立了 in_progress session。
 */
function createSessionBeforeAuthResolves(item: LearningItem): { local: LocalStorageLearningRepository; session: StudySession } {
  const local = new LocalStorageLearningRepository();
  local.addItem({
    language: item.language,
    type: item.type,
    promptZh: item.promptZh,
    answer: item.answer,
    reading: item.reading,
    source: item.source,
    tags: item.tags,
  });
  const result = initializeStudySession(local, new Date("2026-09-20T17:20:00.000Z"));
  if (result.phase !== "active") throw new Error(`預期建立 session，實際是 ${result.phase}`);
  return { local, session: result.session };
}

/** 依 session 的 plannedUnits 逐題作答（走跟 `/study` 頁完全一樣的 repository 呼叫）。 */
function answerAll(repository: LearningRepository, session: StudySession, startAt: Date): void {
  let elapsed = 0;
  for (const unit of session.plannedUnits) {
    const item = repository.getItem(unit.learningItemId);
    if (!item) throw new Error(`測試資料異常：找不到 ${unit.learningItemId}`);
    const exercise = buildExerciseForUnit(item, unit.ability);
    elapsed += 1000;
    repository.recordGradedAttempt({
      sessionId: session.id,
      learningItemId: unit.learningItemId,
      ability: unit.ability,
      exerciseId: exercise.id,
      exerciseType: exercise.exerciseType,
      result: "correct",
      usedHint: false,
      responseTimeMs: 1500,
      now: new Date(startAt.getTime() + elapsed),
    });
  }
}

/** 把本機已有的單字放進假雲端（模擬先前已經同步完成），讓測試只卡在 session 本身。 */
function seedCloudItems(db: FakeSupabaseDatabase, local: LocalStorageLearningRepository): void {
  for (const item of local.listItems()) {
    const row = learningItemToRow(item, USER_ID);
    db.tables.learning_items.rows.push({
      ...row,
      content_key: [row.language, row.type, row.prompt_zh, row.answer, row.reading ?? ""].join("|"),
    });
  }
}

const SAMPLE_ITEM: LearningItem = {
  id: "unused",
  language: "ja",
  type: "vocabulary",
  promptZh: "狗",
  answer: "犬",
  reading: "いぬ",
  source: "manual",
  tags: [],
  status: "new",
  createdAt: "2026-09-19T00:00:00.000Z",
  isSeed: false,
};

beforeEach(() => {
  installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
});

describe("雲端沒有 session 時的作答同步", () => {
  it("冷啟動時先建立 session、登入解析後才作答：session 仍然會上傳，作答不會卡死", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    const { local, session } = createSessionBeforeAuthResolves(SAMPLE_ITEM);
    // 這些單字先前已經同步過（雲端有、本機也有），所以卡住的只會是 session 本身。
    seedCloudItems(db, local);

    // auth resolve：singleton 換成 SyncingLearningRepository（configureCloudSync 的行為）。
    const syncing = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER_ID);

    // `/study` 重新初始化時會恢復既有 session，不會再呼叫 getOrCreateInProgressSession。
    const resumed = initializeStudySession(syncing, new Date("2026-09-20T17:22:00.000Z"));
    expect(resumed.phase).toBe("active");

    answerAll(syncing, session, new Date("2026-09-20T17:22:52.000Z"));

    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);

    expect(drain.message ?? "").not.toContain("不存在");
    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    const remoteSession = db.tables.study_sessions.rows.find((row) => row.id === session.id);
    expect(remoteSession).toBeDefined();
    expect(remoteSession?.planned_units).toEqual(session.plannedUnits);
    expect(db.tables.review_attempts.rows.filter((row) => row.session_id === session.id)).toHaveLength(
      session.plannedUnits.length
    );
    expect(remoteSession?.status).toBe("completed");
  });

  it("既有卡住的資料：outbox 只剩作答、雲端沒有 session 時，仍能安全補送 session 後逐筆落地", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    const { local, session } = createSessionBeforeAuthResolves(SAMPLE_ITEM);
    seedCloudItems(db, local);

    const syncing = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER_ID);
    answerAll(syncing, session, new Date("2026-09-20T17:22:52.000Z"));

    // 手機上實際觀察到的形狀：outbox 只剩 record_graded_attempt，沒有任何 upsert_session。
    // 這批資料是在修復前就已經寫進去的，所以這裡明確還原成那個形狀，
    // 確保測到的是「既有壞狀態的恢復」，不是新版預防機制順手補上的那一筆。
    setOutboxEntries(listOutboxEntries().filter((entry) => entry.type === "record_graded_attempt"));
    const pending = listOutboxEntries();
    expect(pending.every((entry) => entry.type === "record_graded_attempt")).toBe(true);
    expect(pending).toHaveLength(session.plannedUnits.length);

    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);

    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    const attempts = db.tables.review_attempts.rows.filter((row) => row.session_id === session.id);
    expect(attempts).toHaveLength(session.plannedUnits.length);
    expect(attempts.map((row) => row.sequence_in_session)).toEqual(session.plannedUnits.map((_, index) => index));
  });

  it("換帳戶後殘留的別人待送作答：不補送 session、不寫進目前帳戶，佇列完整保留", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    const { local, session } = createSessionBeforeAuthResolves(SAMPLE_ITEM);
    seedCloudItems(db, local); // 這些項目屬於 USER_ID
    const syncing = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER_ID);
    answerAll(syncing, session, new Date("2026-09-20T17:22:52.000Z"));
    setOutboxEntries(listOutboxEntries().filter((entry) => entry.type === "record_graded_attempt"));
    const pendingBefore = listOutboxEntries().length;

    // 換成另一個帳戶登入後才 drain：那些作答不屬於這個帳戶。
    const drain = await drainOutboxFully(asClient(client), undefined, "user_other");

    expect(drain.success).toBe(false);
    expect(drain.message).toContain("cloud_items_missing");
    expect(db.tables.study_sessions.rows).toHaveLength(0);
    expect(db.tables.review_attempts.rows).toHaveLength(0);
    expect(listOutboxEntries()).toHaveLength(pendingBefore);
    // 拒絕原因會留在 entry 上，手機的同步診斷（head.lastError）就能直接看到缺口。
    expect(listOutboxEntries()[0].lastError ?? "").toContain("cloud_items_missing");
  });
});

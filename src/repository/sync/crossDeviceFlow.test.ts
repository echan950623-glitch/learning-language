/**
 * 同步驗證矩陣 A／B 的自動化版本（走真的 repository → outbox → sync engine → RPC 邊界）。
 *
 * A. 新增單字 → 建立 session → 作答 → 完成 → 另一裝置讀取，逐筆核對內容與關聯，
 *    不只比較筆數。
 * B. 離線期間建立 session 並作答，關閉／重開（重新建立 repository 實例、重新從
 *    localStorage 讀 outbox）後才連網，資料一樣完整落地。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage } from "../../test/localStorageMock";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { SyncingLearningRepository } from "../syncingRepository";
import { createEmptyStore, readPersistedStore, writePersistedStore } from "../schema";
import { initializeStudySession } from "../../app/study/sessionInit";
import { buildExerciseForUnit } from "../../domain/exercises";
import type { StudySession } from "../../domain/types";
import { __clearOutboxForTests, listOutboxEntries } from "./outbox";
import { __resetSyncEngineForTests, drainOutboxFully, pullAndMergeRemoteData } from "./syncEngine";
import { createFakeSupabaseClient, FakeSupabaseDatabase, type FakeSupabaseClient } from "./testSupabaseFake";

const USER_ID = "user_matrix";

function asClient(client: FakeSupabaseClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

/** 一台全新的裝置：空的 localStorage、空的 outbox、空的 store（不跑種子資料）。 */
function freshDevice(): void {
  installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
  writePersistedStore(createEmptyStore());
}

function answerEveryUnit(repository: SyncingLearningRepository, session: StudySession): void {
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
      responseTimeMs: 900,
      now: new Date(Date.parse("2026-09-20T18:00:00.000Z") + elapsed),
    });
  }
}

beforeEach(() => {
  freshDevice();
});

describe("同步驗證矩陣：跨裝置流程", () => {
  it("A：新增單字→建立 session→作答→完成→另一裝置讀到相同內容與關聯", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    // --- 裝置一 -------------------------------------------------------------
    const deviceOne = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER_ID);
    const added = deviceOne.addItem({
      language: "ja",
      type: "vocabulary",
      promptZh: "貓",
      answer: "猫",
      reading: "ねこ",
      source: "manual",
      tags: ["動物"],
    });
    const init = initializeStudySession(deviceOne, new Date("2026-09-20T18:00:00.000Z"));
    if (init.phase !== "active") throw new Error(`預期 active，實際是 ${init.phase}`);
    answerEveryUnit(deviceOne, init.session);

    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);
    expect(drain.message ?? "").toBe("");
    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    const localAfterDrain = readPersistedStore();
    const localSession = localAfterDrain.studySessions.find((session) => session.id === init.session.id);
    expect(localSession?.status).toBe("completed");

    // --- 裝置二：全新 localStorage，只靠 pull-merge ---------------------------
    freshDevice();
    await pullAndMergeRemoteData(asClient(client), USER_ID);
    const deviceTwo = readPersistedStore();

    const pulledItem = deviceTwo.items.find((item) => item.id === added.id);
    expect(pulledItem).toMatchObject({
      promptZh: "貓",
      answer: "猫",
      reading: "ねこ",
      tags: ["動物"],
      status: localAfterDrain.items.find((item) => item.id === added.id)?.status,
    });

    const pulledSession = deviceTwo.studySessions.find((session) => session.id === init.session.id);
    expect(pulledSession?.status).toBe("completed");
    expect(pulledSession?.plannedUnits).toEqual(init.session.plannedUnits);
    expect(pulledSession?.exerciseResults.map((result) => result.exerciseId)).toEqual(
      localSession?.exerciseResults.map((result) => result.exerciseId)
    );
    expect(pulledSession?.exerciseResults.map((result) => result.learningItemId)).toEqual(
      localSession?.exerciseResults.map((result) => result.learningItemId)
    );

    // 排程逐筆核對（不是只比數量）：每個 (item, ability) 的數值都要一致。
    const localSchedules = new Map(
      localAfterDrain.scheduleStates.map((schedule) => [`${schedule.learningItemId}:${schedule.ability}`, schedule])
    );
    expect(deviceTwo.scheduleStates).toHaveLength(localSchedules.size);
    for (const schedule of deviceTwo.scheduleStates) {
      const expected = localSchedules.get(`${schedule.learningItemId}:${schedule.ability}`);
      expect(expected).toBeDefined();
      expect({
        dueAt: schedule.dueAt,
        intervalDays: schedule.intervalDays,
        streak: schedule.streak,
        lapseCount: schedule.lapseCount,
      }).toEqual({
        dueAt: expected?.dueAt,
        intervalDays: expected?.intervalDays,
        streak: expected?.streak,
        lapseCount: expected?.lapseCount,
      });
    }

    // 作答紀錄的關聯：session_id／exercise_id 對得上，且數量一致。
    expect(deviceTwo.reviewAttempts).toHaveLength(localAfterDrain.reviewAttempts.length);
    for (const attempt of localAfterDrain.reviewAttempts) {
      const pulled = deviceTwo.reviewAttempts.find(
        (candidate) => candidate.sessionId === attempt.sessionId && candidate.exerciseId === attempt.exerciseId
      );
      expect(pulled).toMatchObject({
        learningItemId: attempt.learningItemId,
        exerciseType: attempt.exerciseType,
        result: attempt.result,
        reviewedAt: attempt.reviewedAt,
      });
    }
  });

  it("B：離線建立 session 並作答，關閉／重開後才連網，資料完整落地", async () => {
    const db = new FakeSupabaseDatabase();
    const client = createFakeSupabaseClient(db);

    const offlineDevice = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER_ID);
    offlineDevice.addItem({
      language: "ja",
      type: "vocabulary",
      promptZh: "水",
      answer: "水",
      reading: "みず",
      source: "manual",
      tags: [],
    });
    const init = initializeStudySession(offlineDevice, new Date("2026-09-20T18:00:00.000Z"));
    if (init.phase !== "active") throw new Error(`預期 active，實際是 ${init.phase}`);
    answerEveryUnit(offlineDevice, init.session);

    const pendingBeforeReopen = listOutboxEntries().length;
    expect(pendingBeforeReopen).toBeGreaterThan(0);

    // 「關閉／重開」：重新建立 repository 與 sync engine 狀態，outbox 從 localStorage 重讀。
    __resetSyncEngineForTests();
    const reopened = new SyncingLearningRepository(new LocalStorageLearningRepository(), USER_ID);
    expect(reopened.getInProgressSession("ja")).toBeUndefined(); // 已作答完畢，session 已 completed
    expect(listOutboxEntries()).toHaveLength(pendingBeforeReopen);

    const drain = await drainOutboxFully(asClient(client), undefined, USER_ID);
    expect(drain.message ?? "").toBe("");
    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    const remoteSession = db.tables.study_sessions.rows.find((row) => row.id === init.session.id);
    expect(remoteSession?.status).toBe("completed");
    expect(db.tables.review_attempts.rows.filter((row) => row.session_id === init.session.id)).toHaveLength(
      init.session.plannedUnits.length
    );
  });
});

/**
 * 真實 Supabase 隔離驗證：雲端缺 session 時的補送與重播。
 *
 * 只建立臨時 Auth 使用者、只用一般登入使用者權限（不是 service role）呼叫 RPC，
 * `afterAll` 刪除使用者後由 FK cascade 清乾淨，不碰任何既有使用者的資料。
 * 必須明確 opt-in（`RUN_REAL_MISSING_SESSION_TEST=1`），一般 `npm test` 不會執行。
 *
 * 驗證重點：
 * 1. 真實 `record_graded_attempt` 在 session 不存在時的錯誤訊息，跟手機上看到的一致。
 * 2. 一般使用者權限可以用 `upsert_study_session_guarded` 補上本機那筆 session。
 * 3. 補上之後原封不動地重送同一批作答，逐筆落地、sequence 正確、session 完成。
 * 4. 回應遺失後重送不會重複計分（冪等）。
 * 5. 直接用本機「最終 completed 狀態」回填的話，伺服器會拒絕後續作答——這正是恢復方案
 *    必須還原成 in_progress 的原因。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage } from "../../test/localStorageMock";
import { createAdminClient } from "../../lib/supabase/admin";
import { LocalStorageLearningRepository } from "../localStorageRepository";
import { SyncingLearningRepository } from "../syncingRepository";
import { createEmptyStore, writePersistedStore } from "../schema";
import { initializeStudySession } from "../../app/study/sessionInit";
import { buildExerciseForUnit } from "../../domain/exercises";
import type { StudySession } from "../../domain/types";
import { __clearOutboxForTests, learningItemToRow, listOutboxEntries, setOutboxEntries, studySessionToRow } from "./outbox";
import { __resetSyncEngineForTests, drainOutboxFully } from "./syncEngine";

try {
  process.loadEnvFile(".env.local");
} catch {
  // CI 沒有本機憑證時由 describe.skip 略過。
}

const hasRealCredentials =
  process.env.RUN_REAL_MISSING_SESSION_TEST === "1" &&
  (Boolean(process.env.SUPABASE_SECRET_KEY) || Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY));
const describeReal = hasRealCredentials ? describe : describe.skip;

describeReal("雲端缺 session 的補送與重播（真實 Supabase 隔離帳戶）", () => {
  let admin: SupabaseClient;
  let client: SupabaseClient;
  let userId = "";

  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("缺少 Supabase URL 或 publishable key");

    admin = createAdminClient();
    const email = `missing-session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const password = `Test-${crypto.randomUUID()}-Aa1!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("建立測試使用者失敗");
    userId = created.data.user.id;

    const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await anon.auth.signInWithPassword({ email, password });
    if (signed.error || !signed.data.session) throw signed.error ?? new Error("測試使用者登入失敗");
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${signed.data.session.access_token}` } },
    });
  }, 30000);

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
  }, 30000);

  /** 重建手機上的狀態：本機有 session 與作答、outbox 只剩 record_graded_attempt。 */
  async function buildStuckState(marker: string): Promise<StudySession> {
    installMockLocalStorage();
    __clearOutboxForTests();
    __resetSyncEngineForTests();
    writePersistedStore(createEmptyStore());

    const local = new LocalStorageLearningRepository();
    local.addItem({
      language: "ja",
      type: "vocabulary",
      promptZh: `缺 session 測試-${marker}`,
      answer: `テスト-${marker}`,
      reading: "てすと",
      source: "manual",
      tags: [],
    });

    // 單字本身先前已經同步過（一般使用者權限、guarded RPC），卡住的只有 session。
    for (const item of local.listItems()) {
      const inserted = await client.rpc("upsert_learning_item_guarded", { payload: learningItemToRow(item, userId) });
      expect(inserted.error).toBeNull();
    }

    // auth 尚未 resolve 時由純本機 repository 建立 session（沒有進 outbox）。
    const init = initializeStudySession(local, new Date());
    if (init.phase !== "active") throw new Error(`預期建立 session，實際是 ${init.phase}`);
    const session = init.session;

    // auth resolve 之後才作答。
    const syncing = new SyncingLearningRepository(new LocalStorageLearningRepository(), userId);
    let elapsed = 0;
    for (const unit of session.plannedUnits) {
      const item = syncing.getItem(unit.learningItemId);
      if (!item) throw new Error("測試資料異常");
      const exercise = buildExerciseForUnit(item, unit.ability);
      elapsed += 1000;
      syncing.recordGradedAttempt({
        sessionId: session.id,
        learningItemId: unit.learningItemId,
        ability: unit.ability,
        exerciseId: exercise.id,
        exerciseType: exercise.exerciseType,
        result: "correct",
        usedHint: false,
        responseTimeMs: 1200,
        now: new Date(Date.now() + elapsed),
      });
    }
    // 還原成修復前實際卡住的形狀：只有作答、沒有任何 upsert_session。
    setOutboxEntries(listOutboxEntries().filter((entry) => entry.type === "record_graded_attempt"));
    return session;
  }

  it("真實 RPC 在 session 不存在時的錯誤，與手機上看到的一致", async () => {
    const session = await buildStuckState(crypto.randomUUID().slice(0, 8));
    const head = listOutboxEntries()[0];
    if (head.type !== "record_graded_attempt") throw new Error("unexpected outbox head");

    const response = await client.rpc("record_graded_attempt", { payload: head.payload });
    expect(response.error?.message ?? "").toContain(`session "${session.id}" 不存在`);
  }, 60000);

  it("補送 session 後逐筆落地：sequence 正確、排程更新、session 完成、outbox 清空", async () => {
    const session = await buildStuckState(crypto.randomUUID().slice(0, 8));
    const expectedCount = session.plannedUnits.length;

    const drain = await drainOutboxFully(client, undefined, userId);
    expect(drain.message ?? "").toBe("");
    expect(drain.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    const remoteSession = await client.from("study_sessions").select("*").eq("id", session.id).maybeSingle();
    expect(remoteSession.error).toBeNull();
    expect(remoteSession.data?.status).toBe("completed");
    expect(remoteSession.data?.planned_units).toEqual(session.plannedUnits);

    const attempts = await client
      .from("review_attempts")
      .select("*")
      .eq("session_id", session.id)
      .order("sequence_in_session", { ascending: true });
    expect(attempts.error).toBeNull();
    expect(attempts.data ?? []).toHaveLength(expectedCount);
    expect((attempts.data ?? []).map((row) => row.sequence_in_session)).toEqual(
      session.plannedUnits.map((_, index) => index)
    );

    const schedules = await client.from("schedule_states").select("*").eq("user_id", userId);
    expect(schedules.error).toBeNull();
    expect((schedules.data ?? []).length).toBeGreaterThan(0);
  }, 120000);

  it("回應遺失後重送同一批作答：不重複計分、不再推進排程", async () => {
    const session = await buildStuckState(crypto.randomUUID().slice(0, 8));
    const payloads = listOutboxEntries()
      .filter((entry) => entry.type === "record_graded_attempt")
      .map((entry) => (entry.type === "record_graded_attempt" ? entry.payload : null));

    const first = await drainOutboxFully(client, undefined, userId);
    expect(first.success).toBe(true);

    const scheduleAfterFirst = await client.from("schedule_states").select("*").eq("user_id", userId);
    const attemptsAfterFirst = await client.from("review_attempts").select("id").eq("session_id", session.id);

    for (const payload of payloads) {
      if (!payload) continue;
      const replay = await client.rpc("record_graded_attempt", { payload });
      expect(replay.error).toBeNull();
    }

    const scheduleAfterReplay = await client.from("schedule_states").select("*").eq("user_id", userId);
    const attemptsAfterReplay = await client.from("review_attempts").select("id").eq("session_id", session.id);
    expect(attemptsAfterReplay.data ?? []).toHaveLength((attemptsAfterFirst.data ?? []).length);
    expect(scheduleAfterReplay.data).toEqual(scheduleAfterFirst.data);
  }, 120000);

  it("用本機最終 completed 狀態回填 session，伺服器會拒絕後續作答", async () => {
    const session = await buildStuckState(crypto.randomUUID().slice(0, 8));
    const localFinal = { ...session, status: "completed" as const, completedAt: new Date().toISOString() };
    const inserted = await client.rpc("upsert_study_session_guarded", {
      payload: studySessionToRow(localFinal, userId),
    });
    expect(inserted.error).toBeNull();

    const head = listOutboxEntries()[0];
    if (head.type !== "record_graded_attempt") throw new Error("unexpected outbox head");
    const response = await client.rpc("record_graded_attempt", { payload: head.payload });
    expect(response.error?.message ?? "").toContain("不能再評分");
  }, 60000);
});

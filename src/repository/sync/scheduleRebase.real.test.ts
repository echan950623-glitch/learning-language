/** 真實 Supabase 隔離驗證：只建立臨時 Auth 使用者，afterAll 刪除後由 FK cascade 清乾淨。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { computeNextSchedule } from "../../domain/srs";
import { installMockLocalStorage } from "../../test/localStorageMock";
import { createAdminClient } from "../../lib/supabase/admin";
import { writePersistedStore } from "../schema";
import { commitItemAlias } from "./alias";
import { __clearOutboxForTests, enqueueOutboxEntry, listOutboxEntries } from "./outbox";
import { __clearRebaseJournalForTests } from "./scheduleRebase";
import { __resetSyncEngineForTests, drainOutboxFully } from "./syncEngine";

try {
  process.loadEnvFile(".env.local");
} catch {
  // CI 沒有本機憑證時由 describe.skip 略過。
}

// 真實環境測試必須明確 opt-in，避免一般 `npm test` 每次都建立 Auth 暫存帳戶。
const hasRealCredentials =
  process.env.RUN_REAL_SCHEDULE_REBASE_TEST === "1" &&
  (Boolean(process.env.SUPABASE_SECRET_KEY) || Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY));
const describeReal = hasRealCredentials ? describe : describe.skip;

describeReal("schedule rebase（真實 Supabase 隔離帳戶）", () => {
  let admin: SupabaseClient;
  let client: SupabaseClient;
  let userId: string | null = null;

  beforeAll(async () => {
    installMockLocalStorage();
    __clearOutboxForTests();
    __resetSyncEngineForTests();

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("缺少 Supabase URL 或 publishable key");

    admin = createAdminClient();
    const email = `schedule-rebase-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

  it("以 canonical 雲端排程動態重算，真實 guarded RPC 寫入一次且清空原 entry", async () => {
    if (!userId) throw new Error("測試使用者不存在");
    const marker = crypto.randomUUID();
    const canonicalId = `item_cloud_${marker}`;
    const localId = `item_local_${marker}`;
    const sessionId = `session_test_${marker}`;
    const exerciseId = `exercise_${marker}`;
    const attemptId = `attempt_${marker}`;
    const reviewedAt = new Date(Date.now() - 60_000).toISOString();
    const cloudReviewedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const cloudDueAt = new Date(Date.now() - 86_400_000).toISOString();

    const item = {
      id: canonicalId,
      user_id: userId,
      language: "ja",
      type: "vocabulary",
      prompt_zh: `重放測試-${marker}`,
      answer: `テスト-${marker}`,
      reading: null,
      explanation: null,
      romaji: null,
      part_of_speech: null,
      example_sentence: null,
      source: "manual",
      tags: [],
      status: "learning",
      created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      is_seed: false,
    };
    expect((await client.from("learning_items").insert(item)).error).toBeNull();
    expect((await client.from("schedule_states").insert({
      user_id: userId,
      learning_item_id: canonicalId,
      ability: "recall",
      language: "ja",
      due_at: cloudDueAt,
      interval_days: 3,
      streak: 2,
      lapse_count: 1,
      last_reviewed_at: cloudReviewedAt,
    })).error).toBeNull();
    expect((await client.from("study_sessions").insert({
      id: sessionId,
      user_id: userId,
      language: "ja",
      status: "in_progress",
      started_at: reviewedAt,
      completed_at: null,
      planned_units: [{ learningItemId: canonicalId, ability: "recall", kind: "new" }],
      new_item_ids: [canonicalId],
      review_item_ids: [],
    })).error).toBeNull();

    writePersistedStore({
      schemaVersion: 2,
      items: [{
        id: localId,
        language: "ja",
        type: "vocabulary",
        promptZh: item.prompt_zh,
        answer: item.answer,
        source: "manual",
        tags: [],
        status: "new",
        createdAt: item.created_at,
        isSeed: false,
      }],
      scheduleStates: [],
      reviewAttempts: [],
      studySessions: [],
    });
    __clearRebaseJournalForTests(userId);

    const localNext = computeNextSchedule(null, "correct", new Date(reviewedAt));
    enqueueOutboxEntry({
      type: "record_graded_attempt",
      payload: {
        attempt_id: attemptId,
        session_id: sessionId,
        learning_item_id: localId,
        ability: "recall",
        exercise_id: exerciseId,
        exercise_type: "recall",
        result: "correct",
        used_hint: false,
        response_time_ms: 321,
        reviewed_at: reviewedAt,
        expected_schedule: null,
        schedule: {
          due_at: localNext.dueAt,
          interval_days: localNext.intervalDays,
          streak: localNext.streak,
          lapse_count: localNext.lapseCount,
        },
        item_status: "learning",
        session_completed: true,
        session_completed_at: reviewedAt,
      },
    });
    // 真實遷移情境：pending 作答先存在，之後才由內容衝突建立 canonical alias。
    commitItemAlias(userId, localId, canonicalId, new Date().toISOString());

    const result = await drainOutboxFully(client, undefined, userId);
    expect(result.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);

    const attempt = await client
      .from("review_attempts")
      .select("id,learning_item_id,session_id,exercise_id,result")
      .eq("session_id", sessionId)
      .eq("exercise_id", exerciseId)
      .single();
    expect(attempt.error).toBeNull();
    expect(attempt.data).toMatchObject({
      id: attemptId,
      learning_item_id: canonicalId,
      session_id: sessionId,
      exercise_id: exerciseId,
      result: "correct",
    });

    const expected = computeNextSchedule({ streak: 2, lapseCount: 1 }, "correct", new Date(reviewedAt));
    const schedule = await client
      .from("schedule_states")
      .select("streak,lapse_count,interval_days,due_at,last_reviewed_at")
      .eq("learning_item_id", canonicalId)
      .eq("ability", "recall")
      .single();
    expect(schedule.error).toBeNull();
    expect(schedule.data).toMatchObject({
      streak: expected.streak,
      lapse_count: expected.lapseCount,
      interval_days: expected.intervalDays,
    });
    expect(new Date(schedule.data!.due_at).toISOString()).toBe(expected.dueAt);
    expect(new Date(schedule.data!.last_reviewed_at!).toISOString()).toBe(reviewedAt);
  }, 30000);
});

/**
 * RLS／RPC 安全測試——對真實 Supabase 專案跑，不是 mock。
 *
 * 對應 ARCHITECTURE.md 雲端化章節「測試策略」小節：
 * - 用 Node 內建 `process.loadEnvFile('.env.local')` 載入真實憑證；沒有 `.env.local`
 *   （例如 CI 環境）時 `loadEnvFile` 會丟例外，這裡吞掉讓下面的 `SUPABASE_SECRET_KEY`
 *   偵測來決定要不要整組 `describe.skip`，`npm test` 在沒有真實憑證時仍然能跑完。
 * - 驗證 RLS（含 client_id 限制）不需要真的走一次 OAuth flow：用 `pg` 對
 *   `POSTGRES_URL_NON_POOLING` 開連線，`SET LOCAL ROLE authenticated` +
 *   `set_config('request.jwt.claims', ..., true)` 模擬任意 JWT claims，直接測 policy。
 * - 需要真實使用者的測試用 `SUPABASE_SECRET_KEY` 建 admin client 建立／刪除測試帳號，
 *   `afterAll` 一定清除，不留測試帳號或資料在 production 專案裡（所有表都有
 *   `on delete cascade` 到 `auth.users`，刪掉測試使用者即可級聯清掉其餘資料）。
 * - 任何輸出都不印 token／secret 實際值，只印布林、數量、id 等非敏感資訊。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseJsClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { createAdminClient } from "./admin";
import type { Database, Json } from "./database.types";

try {
  process.loadEnvFile(".env.local");
} catch {
  // 沒有 .env.local（例如 CI）時忽略，下面用 SUPABASE_SECRET_KEY 是否存在決定要不要 skip。
}

const hasRealCredentials = Boolean(process.env.SUPABASE_SECRET_KEY) || Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeWithRealDb = hasRealCredentials ? describe : describe.skip;

if (!hasRealCredentials) {
  console.log(
    "[rls.test.ts] 找不到 SUPABASE_SECRET_KEY／SUPABASE_SERVICE_ROLE_KEY，略過真實 DB 的 RLS／RPC 測試（describe.skip）。"
  );
}

// ---------------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------------

/** `attempt_<uuid>` 之類的 id 格式沿用 src/domain/id.ts 的 generateId() 慣例。 */
function testId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

type LearningItemInsert = Database["public"]["Tables"]["learning_items"]["Insert"];
type StudySessionInsert = Database["public"]["Tables"]["study_sessions"]["Insert"];
type PlannedUnit = { learningItemId: string; ability: "recall" | "reading"; kind: "review" | "new" };

function makeLearningItemRow(userId: string, overrides: Partial<LearningItemInsert> = {}): LearningItemInsert {
  // `content_key` = language|type|prompt_zh|answer|reading 有 unique(user_id, content_key)
  // 限制（見 migration），promptZh／answer 一定要帶唯一標記，避免同一個測試使用者名下
  // 兩筆不相關的 fixture 撞到同一個 content_key 而互相干擾（這條 unique 限制本身是
  // 故意的、跟本機 addItemsIfMissing 同一套去重鍵，不是要放寬的東西）。
  const uniqueMarker = testId("item_test");
  return {
    id: uniqueMarker,
    user_id: userId,
    language: "ja",
    type: "vocabulary",
    prompt_zh: `測試單字-${uniqueMarker}`,
    answer: `テスト-${uniqueMarker}`,
    source: "manual",
    status: "new",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStudySessionRow(
  userId: string,
  plannedUnits: PlannedUnit[],
  overrides: Partial<StudySessionInsert> = {}
): StudySessionInsert {
  return {
    id: testId("session_test"),
    user_id: userId,
    language: "ja",
    status: "in_progress",
    started_at: new Date().toISOString(),
    planned_units: plannedUnits,
    new_item_ids: plannedUnits.filter((u) => u.kind === "new").map((u) => u.learningItemId),
    review_item_ids: plannedUnits.filter((u) => u.kind === "review").map((u) => u.learningItemId),
    ...overrides,
  };
}

interface GradedAttemptPayload {
  // 讓這個型別可以結構相容於 supabase-js `.rpc()` 期待的 `Json` 參數型別
  // （具名 interface 預設沒有 index signature，需要明講才能被當成 Json 傳入）。
  [key: string]: Json | undefined;
  session_id: string;
  learning_item_id: string;
  ability: "recall" | "reading";
  exercise_id: string;
  exercise_type: "recall" | "reading" | "spelling" | "translation";
  result: "correct" | "partial" | "incorrect";
  used_hint: boolean;
  response_time_ms: number;
  reviewed_at: string;
  schedule: { due_at: string; interval_days: number; streak: number; lapse_count: number };
  item_status: "new" | "learning" | "mastered" | "struggling";
  session_completed: boolean;
  session_completed_at: string | null;
}

describeWithRealDb("Supabase RLS／RPC 安全測試（真實 DB）", () => {
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL) as string;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;

  let admin: SupabaseClient<Database>;
  let pg: PgClient;

  interface TestUser {
    id: string;
    email: string;
    password: string;
    client: SupabaseClient<Database>;
  }
  let userA: TestUser;
  let userB: TestUser;

  async function createSignedInTestUser(label: string): Promise<TestUser> {
    const email = `rls-test-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const password = `Test-${crypto.randomUUID()}-Aa1!`;

    const { data: createData, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError || !createData.user) {
      throw new Error(`建立測試使用者 "${label}" 失敗：${createError?.message}`);
    }

    const anon = createSupabaseJsClient<Database>(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    if (signInError || !signInData.session) {
      throw new Error(`測試使用者 "${label}" 登入失敗：${signInError?.message}`);
    }

    const client = createSupabaseJsClient<Database>(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${signInData.session.access_token}` } },
    });

    return { id: createData.user.id, email, password, client };
  }

  beforeAll(async () => {
    if (!supabaseUrl || !publishableKey) {
      throw new Error("測試設定失敗：缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    }

    admin = createAdminClient();
    userA = await createSignedInTestUser("a");
    userB = await createSignedInTestUser("b");

    const rawConnectionString = process.env.POSTGRES_URL_NON_POOLING;
    if (!rawConnectionString) {
      throw new Error("測試設定失敗：缺少 POSTGRES_URL_NON_POOLING");
    }
    const sep = rawConnectionString.includes("?") ? "&" : "?";
    pg = new PgClient({ connectionString: rawConnectionString + sep + "uselibpqcompat=true" });
    await pg.connect();

    console.log(`[rls.test.ts] 測試使用者已建立：userA=${userA.id.slice(0, 8)}…、userB=${userB.id.slice(0, 8)}…`);
  }, 30000);

  afterAll(async () => {
    // 刪除測試使用者會透過 `on delete cascade` 級聯清掉這兩個帳號名下所有
    // learning_items／schedule_states／study_sessions／review_attempts／user_preferences，
    // 不需要另外手動刪各表的列。
    if (userA?.id) {
      const { error } = await admin.auth.admin.deleteUser(userA.id);
      if (error) console.error("[rls.test.ts] 清除 userA 失敗：", error.message);
    }
    if (userB?.id) {
      const { error } = await admin.auth.admin.deleteUser(userB.id);
      if (error) console.error("[rls.test.ts] 清除 userB 失敗：", error.message);
    }
    if (pg) {
      await pg.query("rollback").catch(() => {});
      await pg.end().catch(() => {});
    }
  }, 30000);

  // -------------------------------------------------------------------------
  // 1. 跨使用者隔離
  // -------------------------------------------------------------------------

  describe("跨使用者隔離（learning_items）", () => {
    it(
      "userA 看不到、改不到、刪不掉 userB 的列",
      async () => {
        const rowA = makeLearningItemRow(userA.id, { prompt_zh: "userA 的字" });
        const rowB = makeLearningItemRow(userB.id, { prompt_zh: "userB 的字" });

        const insertA = await userA.client.from("learning_items").insert(rowA).select();
        expect(insertA.error).toBeNull();
        const insertB = await userB.client.from("learning_items").insert(rowB).select();
        expect(insertB.error).toBeNull();

        // SELECT：userA 查詢 userB 的 id，RLS 讓它看起來就像不存在（回傳空陣列，不是 error）。
        const selectAttempt = await userA.client.from("learning_items").select("*").eq("id", rowB.id);
        expect(selectAttempt.error).toBeNull();
        expect(selectAttempt.data).toEqual([]);

        // UPDATE：userA 嘗試改 userB 的列，USING 讓這列在 userA 眼中不存在，0 rows affected。
        const updateAttempt = await userA.client
          .from("learning_items")
          .update({ status: "mastered" })
          .eq("id", rowB.id)
          .select();
        expect(updateAttempt.error).toBeNull();
        expect(updateAttempt.data).toEqual([]);

        // DELETE：同理，0 rows affected。
        const deleteAttempt = await userA.client.from("learning_items").delete().eq("id", rowB.id).select();
        expect(deleteAttempt.error).toBeNull();
        expect(deleteAttempt.data).toEqual([]);

        // 用 admin client（bypass RLS）確認 userB 的列真的還在、內容沒被動過。
        const verify = await admin.from("learning_items").select("*").eq("id", rowB.id).single();
        expect(verify.error).toBeNull();
        expect(verify.data?.status).toBe("new");
        expect(verify.data?.prompt_zh).toBe("userB 的字");

        // 反向：userB 也看不到 userA 的列（雙向驗證，不是只測單一方向）。
        const reverseSelect = await userB.client.from("learning_items").select("*").eq("id", rowA.id);
        expect(reverseSelect.error).toBeNull();
        expect(reverseSelect.data).toEqual([]);
      },
      20000
    );
  });

  // -------------------------------------------------------------------------
  // 2. client_id 限制（RESTRICTIVE-equivalent：MCP／OAuth token 被窄化）
  // -------------------------------------------------------------------------

  describe("client_id 限制（模擬 MCP／OAuth token）", () => {
    let fixtureItem: LearningItemInsert;
    let fixtureSession: StudySessionInsert;

    beforeAll(async () => {
      // 用 userA 自己一般登入的 client（沒有 client_id claim）先建立好會被拿來測試的
      // 既有列——這樣之後模擬「同一個使用者、但 token 帶 client_id」時，rejection
      // 的唯一可能原因就是 client_id 條件本身，不會跟「這本來就不是我的列」混在一起。
      fixtureItem = makeLearningItemRow(userA.id, { prompt_zh: "client_id 測試用字" });
      const itemInsert = await userA.client.from("learning_items").insert(fixtureItem).select().single();
      expect(itemInsert.error).toBeNull();

      fixtureSession = makeStudySessionRow(userA.id, [
        { learningItemId: fixtureItem.id, ability: "recall", kind: "new" },
      ]);
      const sessionInsert = await userA.client.from("study_sessions").insert(fixtureSession).select().single();
      expect(sessionInsert.error).toBeNull();

      const scheduleInsert = await userA.client
        .from("schedule_states")
        .insert({
          user_id: userA.id,
          learning_item_id: fixtureItem.id,
          ability: "recall",
          language: "ja",
          due_at: isoInDays(1),
          interval_days: 1,
          streak: 0,
          lapse_count: 0,
        })
        .select();
      expect(scheduleInsert.error).toBeNull();

      const attemptInsert = await userA.client
        .from("review_attempts")
        .insert({
          id: testId("attempt_test"),
          user_id: userA.id,
          session_id: fixtureSession.id,
          sequence_in_session: 0,
          exercise_id: "client-id-fixture-exercise",
          learning_item_id: fixtureItem.id,
          language: "ja",
          exercise_type: "recall",
          result: "incorrect",
          used_hint: false,
          response_time_ms: 1000,
          reviewed_at: new Date().toISOString(),
        })
        .select();
      expect(attemptInsert.error).toBeNull();
    }, 20000);

    async function setSimulatedJwt(claims: Record<string, unknown>): Promise<void> {
      await pg.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    }

    async function withRole(fn: () => Promise<void>): Promise<void> {
      await pg.query("begin");
      await pg.query("set local role authenticated");
      try {
        await fn();
      } finally {
        await pg.query("rollback");
      }
    }

    async function expectRlsRejected(sql: string, params: unknown[]): Promise<Error> {
      await pg.query("savepoint sp");
      try {
        await pg.query(sql, params);
        await pg.query("rollback to savepoint sp");
        throw new Error(`預期這個陳述式會被 RLS 擋下，但它成功了：${sql}`);
      } catch (e) {
        const err = e as Error & { message: string };
        if (err.message.startsWith("預期這個陳述式會被 RLS 擋下")) {
          throw err;
        }
        await pg.query("rollback to savepoint sp");
        return err;
      }
    }

    async function countAffected(sql: string, params: unknown[]): Promise<number> {
      await pg.query("savepoint sp");
      const result = await pg.query(sql, params);
      await pg.query("rollback to savepoint sp");
      return result.rowCount ?? 0;
    }

    it(
      "帶 client_id 的模擬 token：SELECT learning_items／review_attempts／schedule_states 仍然成功",
      async () => {
        await withRole(async () => {
          await setSimulatedJwt({ sub: userA.id, role: "authenticated", client_id: "mcp-simulated-client" });

          const items = await pg.query("select id from public.learning_items where id = $1", [fixtureItem.id]);
          expect(items.rowCount).toBe(1);

          const schedules = await pg.query(
            "select learning_item_id from public.schedule_states where learning_item_id = $1 and ability = $2",
            [fixtureItem.id, "recall"]
          );
          expect(schedules.rowCount).toBe(1);

          const attempts = await pg.query("select id from public.review_attempts where session_id = $1", [
            fixtureSession.id,
          ]);
          expect(attempts.rowCount).toBe(1);
        });
      },
      20000
    );

    it(
      "帶 client_id 的模擬 token：SELECT study_sessions 被擋（回傳 0 筆，MCP 完全不能碰這張表）",
      async () => {
        await withRole(async () => {
          await setSimulatedJwt({ sub: userA.id, role: "authenticated", client_id: "mcp-simulated-client" });
          const sessions = await pg.query("select id from public.study_sessions where id = $1", [fixtureSession.id]);
          expect(sessions.rowCount).toBe(0);
        });
      },
      20000
    );

    it(
      "帶 client_id 的模擬 token：INSERT schedule_states／review_attempts／study_sessions 全部被 RLS 拒絕",
      async () => {
        await withRole(async () => {
          await setSimulatedJwt({ sub: userA.id, role: "authenticated", client_id: "mcp-simulated-client" });

          const scheduleErr = await expectRlsRejected(
            `insert into public.schedule_states
               (user_id, learning_item_id, ability, language, due_at, interval_days, streak, lapse_count)
             values ($1, $2, 'reading', 'ja', now() + interval '1 day', 1, 0, 0)`,
            [userA.id, fixtureItem.id]
          );
          expect(scheduleErr.message).toMatch(/row-level security/i);

          const attemptErr = await expectRlsRejected(
            `insert into public.review_attempts
               (id, user_id, session_id, sequence_in_session, exercise_id, learning_item_id,
                language, exercise_type, result, used_hint, response_time_ms, reviewed_at)
             values ($1, $2, $3, 1, 'client-id-blocked-exercise', $4, 'ja', 'recall', 'correct', false, 500, now())`,
            [testId("attempt_test"), userA.id, fixtureSession.id, fixtureItem.id]
          );
          expect(attemptErr.message).toMatch(/row-level security/i);

          const sessionErr = await expectRlsRejected(
            `insert into public.study_sessions
               (id, user_id, language, status, started_at, planned_units)
             values ($1, $2, 'ja', 'in_progress', now(), '[]'::jsonb)`,
            [testId("session_test"), userA.id]
          );
          expect(sessionErr.message).toMatch(/row-level security/i);
        });
      },
      20000
    );

    it(
      "帶 client_id 的模擬 token：UPDATE schedule_states／review_attempts 影響 0 筆（USING 就先擋掉了）",
      async () => {
        await withRole(async () => {
          await setSimulatedJwt({ sub: userA.id, role: "authenticated", client_id: "mcp-simulated-client" });

          const scheduleAffected = await countAffected(
            "update public.schedule_states set streak = 999 where learning_item_id = $1 and ability = $2",
            [fixtureItem.id, "recall"]
          );
          expect(scheduleAffected).toBe(0);

          const attemptAffected = await countAffected(
            "update public.review_attempts set result = 'correct' where session_id = $1 and exercise_id = $2",
            [fixtureSession.id, "client-id-fixture-exercise"]
          );
          expect(attemptAffected).toBe(0);
        });
      },
      20000
    );

    it(
      "帶 client_id 的模擬 token：DELETE learning_items 影響 0 筆（MCP 永遠不能刪字）",
      async () => {
        await withRole(async () => {
          await setSimulatedJwt({ sub: userA.id, role: "authenticated", client_id: "mcp-simulated-client" });
          const affected = await countAffected("delete from public.learning_items where id = $1", [fixtureItem.id]);
          expect(affected).toBe(0);
        });

        const verify = await admin.from("learning_items").select("id").eq("id", fixtureItem.id).maybeSingle();
        expect(verify.error).toBeNull();
        expect(verify.data?.id).toBe(fixtureItem.id);
      },
      20000
    );

    it(
      "正對照：拿掉 client_id 之後，同樣的 INSERT／UPDATE 會成功（證明上面的拒絕確實只是因為 client_id）",
      async () => {
        await withRole(async () => {
          await setSimulatedJwt({ sub: userA.id, role: "authenticated" });

          const scheduleAffected = await countAffected(
            "update public.schedule_states set streak = 3 where learning_item_id = $1 and ability = $2",
            [fixtureItem.id, "recall"]
          );
          expect(scheduleAffected).toBe(1);

          await pg.query("savepoint sp_positive_insert");
          const insertResult = await pg.query(
            `insert into public.schedule_states
               (user_id, learning_item_id, ability, language, due_at, interval_days, streak, lapse_count)
             values ($1, $2, 'reading', 'ja', now() + interval '1 day', 1, 0, 0)
             returning learning_item_id`,
            [userA.id, fixtureItem.id]
          );
          expect(insertResult.rowCount).toBe(1);
          await pg.query("rollback to savepoint sp_positive_insert");
        });
      },
      20000
    );
  });

  // -------------------------------------------------------------------------
  // 3. record_graded_attempt RPC
  // -------------------------------------------------------------------------

  describe("record_graded_attempt", () => {
    async function seedSingleUnitSession(userId: string, client: SupabaseClient<Database>) {
      const item = makeLearningItemRow(userId);
      const itemInsert = await client.from("learning_items").insert(item).select().single();
      expect(itemInsert.error).toBeNull();

      const session = makeStudySessionRow(userId, [{ learningItemId: item.id, ability: "recall", kind: "new" }]);
      const sessionInsert = await client.from("study_sessions").insert(session).select().single();
      expect(sessionInsert.error).toBeNull();

      return { item, session };
    }

    it(
      "正常評分：新增 attempt、upsert schedule、更新 item status、完成 session",
      async () => {
        const { item, session } = await seedSingleUnitSession(userA.id, userA.client);

        const payload: GradedAttemptPayload = {
          session_id: session.id,
          learning_item_id: item.id,
          ability: "recall",
          exercise_id: "happy-path-ex-1",
          exercise_type: "recall",
          result: "correct",
          used_hint: false,
          response_time_ms: 1500,
          reviewed_at: new Date().toISOString(),
          schedule: { due_at: isoInDays(1), interval_days: 1, streak: 1, lapse_count: 0 },
          item_status: "learning",
          session_completed: true,
          session_completed_at: new Date().toISOString(),
        };

        const { data, error } = await userA.client.rpc("record_graded_attempt", { payload });
        expect(error).toBeNull();

        const result = data as unknown as {
          schedule: { streak: number; interval_days: number };
          item_status: string;
          attempt: { exercise_id: string; result: string };
          session: { status: string };
        };
        expect(result.attempt.exercise_id).toBe("happy-path-ex-1");
        expect(result.attempt.result).toBe("correct");
        expect(result.schedule.streak).toBe(1);
        expect(result.item_status).toBe("learning");
        expect(result.session.status).toBe("completed");
      },
      20000
    );

    it(
      "冪等：同一個 exercise_id 重送第二次不會建立第二筆 attempt，也不會用新 payload 覆蓋既有排程",
      async () => {
        const { item, session } = await seedSingleUnitSession(userA.id, userA.client);

        const firstPayload: GradedAttemptPayload = {
          session_id: session.id,
          learning_item_id: item.id,
          ability: "recall",
          exercise_id: "idempotent-ex-1",
          exercise_type: "recall",
          result: "correct",
          used_hint: false,
          response_time_ms: 1200,
          reviewed_at: new Date().toISOString(),
          schedule: { due_at: isoInDays(1), interval_days: 1, streak: 1, lapse_count: 0 },
          item_status: "learning",
          session_completed: true,
          session_completed_at: new Date().toISOString(),
        };

        const first = await userA.client.rpc("record_graded_attempt", { payload: firstPayload });
        expect(first.error).toBeNull();

        // 第二次送出：payload 的排程／狀態刻意跟第一次不一樣，用來證明冪等分支
        // 「完全不理會這次送來的新值」，而不是碰巧算出一樣的結果。
        const retryPayload: GradedAttemptPayload = {
          ...firstPayload,
          result: "incorrect",
          schedule: { due_at: isoInDays(30), interval_days: 30, streak: 99, lapse_count: 5 },
          item_status: "mastered",
        };
        const retry = await userA.client.rpc("record_graded_attempt", { payload: retryPayload });
        expect(retry.error).toBeNull();

        const retryResult = retry.data as unknown as {
          schedule: { streak: number };
          item_status: string;
          attempt: { result: string };
        };
        // 冪等 no-op：回傳的是第一次真正寫入的現況，不是第二次 payload 裡的新值。
        expect(retryResult.schedule.streak).toBe(1);
        expect(retryResult.item_status).toBe("learning");
        expect(retryResult.attempt.result).toBe("correct");

        const countCheck = await userA.client
          .from("review_attempts")
          .select("id", { count: "exact", head: true })
          .eq("session_id", session.id)
          .eq("exercise_id", "idempotent-ex-1");
        expect(countCheck.count).toBe(1);
      },
      20000
    );

    it(
      "原子性／拒絕：learning_item_id 跟 session 的下一個 planned unit 對不上時整個呼叫失敗、不留任何部分寫入",
      async () => {
        const itemExpected = makeLearningItemRow(userA.id, { prompt_zh: "應該被評分的項目" });
        const itemWrong = makeLearningItemRow(userA.id, { prompt_zh: "不應該出現在這裡的項目" });
        const itemExpectedInsert = await userA.client.from("learning_items").insert(itemExpected).select().single();
        expect(itemExpectedInsert.error).toBeNull();
        const itemWrongInsert = await userA.client.from("learning_items").insert(itemWrong).select().single();
        expect(itemWrongInsert.error).toBeNull();

        const session = makeStudySessionRow(userA.id, [
          { learningItemId: itemExpected.id, ability: "recall", kind: "new" },
        ]);
        const sessionInsert = await userA.client.from("study_sessions").insert(session).select().single();
        expect(sessionInsert.error).toBeNull();

        const mismatchedPayload: GradedAttemptPayload = {
          session_id: session.id,
          learning_item_id: itemWrong.id, // 故意錯：session 的下一題其實是 itemExpected
          ability: "recall",
          exercise_id: "mismatched-ex-1",
          exercise_type: "recall",
          result: "correct",
          used_hint: false,
          response_time_ms: 1000,
          reviewed_at: new Date().toISOString(),
          schedule: { due_at: isoInDays(1), interval_days: 1, streak: 1, lapse_count: 0 },
          item_status: "learning",
          session_completed: true,
          session_completed_at: new Date().toISOString(),
        };

        const { data, error } = await userA.client.rpc("record_graded_attempt", { payload: mismatchedPayload });
        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.message).toMatch(/learningItemId/);

        // 沒有任何部分寫入：review_attempts 沒有新列、schedule_states 沒有被建立、
        // session 仍然是 in_progress。
        const attemptsCheck = await userA.client
          .from("review_attempts")
          .select("id", { count: "exact", head: true })
          .eq("session_id", session.id);
        expect(attemptsCheck.count).toBe(0);

        const scheduleCheck = await userA.client
          .from("schedule_states")
          .select("learning_item_id")
          .eq("learning_item_id", itemWrong.id)
          .eq("ability", "recall");
        expect(scheduleCheck.data).toEqual([]);

        const sessionCheck = await userA.client.from("study_sessions").select("status").eq("id", session.id).single();
        expect(sessionCheck.data?.status).toBe("in_progress");
      },
      20000
    );
  });

  // -------------------------------------------------------------------------
  // 4. mark_attempt_correct RPC
  // -------------------------------------------------------------------------

  describe("mark_attempt_correct", () => {
    async function gradeOnce(
      userId: string,
      client: SupabaseClient<Database>,
      item: LearningItemInsert,
      session: StudySessionInsert,
      exerciseId: string,
      result: "correct" | "partial" | "incorrect"
    ) {
      const payload: GradedAttemptPayload = {
        session_id: session.id,
        learning_item_id: item.id,
        ability: "recall",
        exercise_id: exerciseId,
        exercise_type: "recall",
        result,
        used_hint: false,
        response_time_ms: 1000,
        reviewed_at: new Date().toISOString(),
        schedule: { due_at: isoInDays(1), interval_days: 1, streak: result === "correct" ? 1 : 0, lapse_count: result === "correct" ? 0 : 1 },
        item_status: result === "correct" ? "learning" : "struggling",
        session_completed: true,
        session_completed_at: new Date().toISOString(),
      };
      const { error } = await client.rpc("record_graded_attempt", { payload });
      expect(error).toBeNull();
      void userId;
    }

    it(
      "正常修正：把 session 最後一題的 incorrect 改判為 correct",
      async () => {
        const item = makeLearningItemRow(userA.id);
        const itemInsert = await userA.client.from("learning_items").insert(item);
        expect(itemInsert.error).toBeNull();
        const session = makeStudySessionRow(userA.id, [{ learningItemId: item.id, ability: "recall", kind: "new" }]);
        const sessionInsert = await userA.client.from("study_sessions").insert(session);
        expect(sessionInsert.error).toBeNull();

        await gradeOnce(userA.id, userA.client, item, session, "mark-correct-ex-1", "incorrect");

        const { data, error } = await userA.client.rpc("mark_attempt_correct", {
          payload: {
            session_id: session.id,
            exercise_id: "mark-correct-ex-1",
            schedule: { due_at: isoInDays(1), interval_days: 1, streak: 1, lapse_count: 1 },
            item_status: "learning",
          },
        });
        expect(error).toBeNull();

        const result = data as unknown as { attempt: { result: string }; schedule: { streak: number }; item_status: string };
        expect(result.attempt.result).toBe("correct");
        expect(result.schedule.streak).toBe(1);
        expect(result.item_status).toBe("learning");
      },
      20000
    );

    it(
      "拒絕：這個 (learning_item_id, ability) 之後已經有更新的作答時，修正舊的那筆會被拒絕",
      async () => {
        const item = makeLearningItemRow(userA.id, { prompt_zh: "newer-attempt 測試字" });
        const itemInsert = await userA.client.from("learning_items").insert(item);
        expect(itemInsert.error).toBeNull();

        // session 1：對這個字的 recall 答錯（較舊的一筆）。
        const sessionOld = makeStudySessionRow(userA.id, [
          { learningItemId: item.id, ability: "recall", kind: "new" },
        ]);
        const sessionOldInsert = await userA.client.from("study_sessions").insert(sessionOld);
        expect(sessionOldInsert.error).toBeNull();
        await gradeOnce(userA.id, userA.client, item, sessionOld, "newer-test-old", "incorrect");

        // session 2：對「同一個字、同一個 ability」再答一次（較新的一筆，seq 更大）。
        const sessionNew = makeStudySessionRow(userA.id, [
          { learningItemId: item.id, ability: "recall", kind: "review" },
        ]);
        const sessionNewInsert = await userA.client.from("study_sessions").insert(sessionNew);
        expect(sessionNewInsert.error).toBeNull();
        await gradeOnce(userA.id, userA.client, item, sessionNew, "newer-test-new", "correct");

        // 現在嘗試修正 session 1 那筆較舊的 attempt——即使它是 sessionOld 自己的最後一筆，
        // 全域來看 (item, recall) 已經有更新的作答，必須被拒絕。
        const { data, error } = await userA.client.rpc("mark_attempt_correct", {
          payload: {
            session_id: sessionOld.id,
            exercise_id: "newer-test-old",
            schedule: { due_at: isoInDays(1), interval_days: 1, streak: 1, lapse_count: 1 },
            item_status: "learning",
          },
        });
        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.message).toMatch(/更新的作答紀錄|newer/);

        // 確認完全沒有寫入：舊的 attempt 仍然是 incorrect。
        const verify = await userA.client
          .from("review_attempts")
          .select("result")
          .eq("session_id", sessionOld.id)
          .eq("exercise_id", "newer-test-old")
          .single();
        expect(verify.data?.result).toBe("incorrect");
      },
      20000
    );
  });
});

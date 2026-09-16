/**
 * 對真實 Supabase 專案的整合測試（不是單元測試）：驗證 MCP 工具在真正的 Postgrest／RLS
 * 之下也能正常運作，而不是只驗證我方手寫的假 client。用 `SUPABASE_SECRET_KEY` 的 admin
 * API 建立一個一次性測試帳號、用密碼登入拿到真的 access token、比照
 * `src/lib/mcp/auth.ts` 的做法建立 RLS-scoped client，跑完在 `afterAll` 刪除帳號
 * （`on delete cascade` 會一併清掉這個帳號寫入的 learning_items 列）。
 *
 * 沒有 `SUPABASE_SECRET_KEY`（例如 CI 環境沒有 `.env.local`）時整組 describe 直接 skip，
 * 不會讓 `npm test` 失敗。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authenticateMcpRequest } from "@/lib/mcp/auth";

import { handler as addHandler } from "./addVocabularyBatch";
import { handler as inventoryHandler } from "./getVocabularyInventory";
import { handler as previewHandler } from "./previewVocabularyBatch";

try {
  process.loadEnvFile(".env.local");
} catch {
  // 沒有 .env.local（例如 CI）時安全略過，交給下面的 hasCredentials 判斷負責 skip。
}

const hasCredentials = Boolean(process.env.SUPABASE_URL) && Boolean(process.env.SUPABASE_SECRET_KEY);
const maybeDescribe = hasCredentials ? describe : describe.skip;

maybeDescribe("MCP 工具 × 真實 Supabase 專案（需要 .env.local 的 SUPABASE_SECRET_KEY）", () => {
  const supabaseUrl = process.env.SUPABASE_URL as string;
  const secretKey = process.env.SUPABASE_SECRET_KEY as string;
  const publishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string;

  const adminClient = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const testEmail = `mcp-agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const testPassword = `Test-${Math.random().toString(36).slice(2, 12)}!A1`;

  let userId: string | undefined;
  let accessToken: string;
  let scopedClient: SupabaseClient;

  beforeAll(async () => {
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (createError || !created.user) {
      throw new Error(`建立測試使用者失敗: ${createError?.message ?? "no user returned"}`);
    }
    userId = created.user.id;

    const anonClient = createClient(supabaseUrl, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: signedIn, error: signInError } = await anonClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    if (signInError || !signedIn.session) {
      throw new Error(`測試使用者登入失敗: ${signInError?.message ?? "no session returned"}`);
    }

    accessToken = signedIn.session.access_token;

    // 比照 src/lib/mcp/auth.ts 的做法：用該使用者的 access token 建立 RLS-scoped client。
    scopedClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }, 30000);

  afterAll(async () => {
    if (userId) {
      await adminClient.auth.admin.deleteUser(userId);
    }
  });

  it("authenticateMcpRequest 對真的 access token 驗證成功，回傳正確的 userId（auth.test.ts 只用 mock，這裡補真的 Supabase 呼叫）", async () => {
    const req = new Request("https://app.example.com/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.context.userId).toBe(userId);
    expect(result.context.accessToken).toBe(accessToken);
  }, 15000);

  it("authenticateMcpRequest 對假造的 token 驗證失敗，回傳 401", async () => {
    const req = new Request("https://app.example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer clearly-not-a-real-token" },
    });

    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(401);
  }, 15000);

  it("新使用者一開始沒有任何單字，get_vocabulary_inventory 回傳全空", async () => {
    const result = await inventoryHandler(scopedClient, { limit: 500 });
    expect(result.totalCount).toBe(0);
    expect(result.items).toEqual([]);
  }, 15000);

  it("preview → add → preview 偵測到重複：完整走一次真實的 RLS-scoped 查詢與 upsert", async () => {
    const item = { promptZh: `測試貓_${Date.now()}`, answer: `猫_${Date.now()}`, reading: "ねこ" };

    const preview = await previewHandler(scopedClient, { items: [item] });
    expect(preview.validItems).toHaveLength(1);
    expect(preview.duplicates).toHaveLength(0);
    expect(preview.validItems[0].romaji).toBe("neko");

    const added = await addHandler(scopedClient, userId as string, { items: [item], confirm: true });
    expect(added.errors).toHaveLength(0);
    expect(added.inserted).toHaveLength(1);
    expect(added.inserted[0]).toMatchObject({ status: "new", source: "ai" });

    const previewAgain = await previewHandler(scopedClient, { items: [item] });
    expect(previewAgain.validItems).toHaveLength(0);
    expect(previewAgain.duplicates).toEqual([
      expect.objectContaining({ reason: "existing_in_database", existingItemId: added.inserted[0].id }),
    ]);

    const inventory = await inventoryHandler(scopedClient, { limit: 500 });
    expect(inventory.totalCount).toBe(1);
  }, 30000);
});

/**
 * ⚠️⚠️⚠️ Service-role Supabase client 工廠 —— 絕對不能從任何 "use client" 檔案、
 * 任何瀏覽器可觸及的程式碼、或 `/mcp`／`/api/**` 等會處理外部使用者請求的 Route
 * Handler 中 import 這個檔案。⚠️⚠️⚠️
 *
 * service role（secret）key 會完全繞過 Row Level Security，等同資料庫最高權限；
 * 任何拿得到它的呼叫者可以讀寫任何使用者的資料。這個工廠**只**給以下用途使用：
 * - 測試設定（例如 `rls.test.ts` 用 `auth.admin.createUser`／`deleteUser` 建立與清除
 *   測試帳號）。
 * - 一次性管理腳本（本機執行、不是部署到任何伺服器端點的程式碼）。
 *
 * MCP／OAuth 相關程式碼（C 的範圍）必須改用一般 publishable key client＋使用者自己的
 * access token（見 ARCHITECTURE.md 雲端化章節「MCP」小節），讓 RLS 正常生效；
 * 絕對不要為了「方便」在那裡改用這個工廠。
 *
 * 優先使用新式 `SUPABASE_SECRET_KEY`；若環境只設定了舊式 `SUPABASE_SERVICE_ROLE_KEY`
 * 則退回使用它（專案目前兩者都存在，見 ARCHITECTURE.md 雲端化章節「環境變數」）。
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export function createAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "createAdminClient 初始化失敗：缺少 SUPABASE_URL（或 NEXT_PUBLIC_SUPABASE_URL）或 " +
        "SUPABASE_SECRET_KEY（或 SUPABASE_SERVICE_ROLE_KEY）環境變數。這個工廠只應該在 " +
        "有 .env.local 或等同機密的本機／測試環境中呼叫，不應該出現在一般執行路徑上。"
    );
  }

  return createSupabaseClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      // 這是給短命的腳本／測試用的 client，不需要、也不應該持久化或自動刷新 session。
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

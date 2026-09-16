/**
 * 瀏覽器端 Supabase client 工廠 + 公開設定讀取。
 *
 * `createBrowserClient()` 只能從 "use client" 元件／瀏覽器執行的程式碼呼叫。用
 * `@supabase/ssr` 的 `createBrowserClient`，session 會同步寫進 cookie（不是只有
 * localStorage），讓 `server.ts` 的伺服器端 client 也能讀到同一個登入狀態。
 *
 * `getSupabasePublicConfig()` 只回傳驗證過的 `{ url, publishableKey }`，不建立任何
 * client——給需要自己組 client 的呼叫端用（例如 MCP 的 `/mcp` route：每個請求要用
 * 使用者自己的 access token 建立當次請求專用的 client，帶著 cookie 的
 * `createBrowserClient()`／`createSupabaseServerClient()` 都不適用，見
 * ARCHITECTURE.md 雲端化章節「MCP」小節）。
 *
 * 一律使用 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（新式 publishable key）。舊式
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` 目前雖然也存在於環境變數中，但新程式一律不用，
 * 見 ARCHITECTURE.md 雲端化章節「環境變數」——這裡沒有 fallback 到 anon key 是刻意的。
 *
 * 這兩個匯出名稱是三邊並行開發時故意協調過的，不是隨意選擇：
 * - `createBrowserClient`：跟內部呼叫的 `@supabase/ssr` 同名函式撞名，用 import alias
 *   解決；`src/app/auth/sign-in/page.tsx`、`src/components/AuthSyncBootstrapper.tsx`
 *   已經依這個名稱呼叫，沿用它避免破壞已經寫好的呼叫端。
 * - `getSupabasePublicConfig`：`src/lib/mcp/auth.ts` 的暫時頂替實作已經在註解裡指名
 *   之後要換成 `import { getSupabasePublicConfig } from "@/lib/supabase/client"`，
 *   沿用這個名稱與回傳形狀（`{ url, publishableKey }`）讓那邊之後的整合是單純代換。
 */
import { createBrowserClient as createSupabaseBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

export function getSupabasePublicConfig(): { url: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Supabase 公開設定讀取失敗：缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 環境變數"
    );
  }

  return { url, publishableKey };
}

export function createBrowserClient() {
  const { url, publishableKey } = getSupabasePublicConfig();
  return createSupabaseBrowserClient<Database>(url, publishableKey);
}

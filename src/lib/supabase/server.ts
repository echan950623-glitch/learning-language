/**
 * 伺服器端 Supabase client 工廠（Server Component／Route Handler／Server Action 專用）。
 *
 * 用 `@supabase/ssr` 的 `createServerClient`，透過 `next/headers` 的 `cookies()`
 * 讀寫 session cookie，讓瀏覽器端（`client.ts`）與伺服器端共用同一個登入狀態。
 *
 * 這裡用的仍然是 publishable key（一般使用者權限），RLS 照常套用——**不是** service
 * role client。需要繞過 RLS 的管理操作（測試設定、腳本）請用 `admin.ts`。
 *
 * 依 `@supabase/ssr` 文件建議：每次 request 都要建立新的 client（不要跨 request
 * 共用），這裡刻意寫成每次呼叫都回傳新實例（不做 module-level 單例快取）。
 *
 * 匯出名稱是 `createSupabaseServerClient`，不是泛用的 `createClient`：一來會跟本檔內
 * 從 `@supabase/ssr` 匯入的同名 `createServerClient` 撞名，二來
 * `src/lib/mcp/oauthSupabaseServerClient.ts`（C 的暫時頂替實作）已經在註解裡指名
 * 之後要換成 `import { createSupabaseServerClient } from "@/lib/supabase/server"`，
 * 沿用這個名稱讓 C 之後的整合可以直接照做，是三邊並行開發時故意的命名協調。
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

export async function createSupabaseServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Supabase 伺服器端 client 初始化失敗：缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 環境變數"
    );
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // 在 Server Component（非 Server Action／Route Handler）呼叫 set() 會拋例外，
          // 因為 Server Component 沒有辦法把 Set-Cookie 寫回 response。這是預期情況：
          // 只要有 middleware 負責在每個 request 刷新／寫回 session，這裡可以安全忽略；
          // 若沒有 middleware，登入狀態的刷新會遺失，但這屬於 B（auth／sync）的頁面
          // 串接範圍，不是這個工廠函式本身的責任。
        }
      },
    },
  });
}

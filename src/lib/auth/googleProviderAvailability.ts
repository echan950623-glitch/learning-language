/**
 * 伺服器端查詢這個 Supabase 專案是否已經真的啟用 Google OAuth provider。
 *
 * 打 GoTrue 公開的 `/auth/v1/settings`（只需要 publishable key，不是管理端 API），
 * `cache: "no-store"` 避免拿到過期狀態。任何失敗（環境變數缺漏、網路錯誤、非 200、
 * 回應格式不符預期）一律 fail closed 回傳 false——畫面必須把 Google 登入視為「尚未
 * 啟用」，絕不能在還沒真的確認 provider 可用時，就顯示一個看起來能點的按鈕。
 */
import { getSupabasePublicConfig } from "@/lib/supabase/client";

interface SupabaseAuthSettings {
  external?: Record<string, unknown>;
}

export async function isGoogleOAuthProviderAvailable(): Promise<boolean> {
  let url: string;
  let publishableKey: string;
  try {
    ({ url, publishableKey } = getSupabasePublicConfig());
  } catch {
    console.error("【登入】讀取 Supabase 設定失敗，Google 登入視為不可用:", {
      category: "supabase_config_unavailable",
      timestamp: new Date().toISOString(),
    });
    return false;
  }

  try {
    const settingsUrl = new URL("/auth/v1/settings", url);
    const response = await fetch(settingsUrl, {
      headers: { apikey: publishableKey },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.error("【登入】查詢 Google OAuth 可用性失敗，視為不可用:", {
        message: "Supabase /auth/v1/settings 回應非 200",
        code: response.status,
        timestamp: new Date().toISOString(),
      });
      return false;
    }

    const data: unknown = await response.json();
    const external = (data as SupabaseAuthSettings | null)?.external;
    if (!external || typeof external !== "object") return false;

    return external.google === true;
  } catch {
    console.error("【登入】查詢 Google OAuth 可用性時發生例外，視為不可用:", {
      category: "provider_availability_failed",
      timestamp: new Date().toISOString(),
    });
    return false;
  }
}

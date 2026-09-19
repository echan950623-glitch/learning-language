/**
 * 觸發 Google OAuth 登入的最小封裝，方便脫離瀏覽器環境單獨測試呼叫參數是否正確。
 *
 * 固定 `provider: "google"`、固定 `queryParams: { prompt: "select_account" }`——
 * 強制每次都顯示 Google 的帳戶選擇畫面，不要讓瀏覽器直接沿用目前登入的 Google 帳戶，
 * 避免使用者不小心用跟既有 GPT 連結帳戶不同的 Email 登入。刻意不帶任何 `scopes`：
 * 不要求任何額外的敏感權限，只用 Supabase 預設的基本 OpenID 資料（email／profile）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type SignInWithOAuth = SupabaseClient["auth"]["signInWithOAuth"];

export interface GoogleSignInClient {
  auth: { signInWithOAuth: SignInWithOAuth };
}

export interface GoogleSignInResult {
  error: string | null;
}

const GENERIC_ERROR_MESSAGE = "無法啟動 Google 登入，請稍後再試，或改用下方 Email 登入連結。";

export async function startGoogleSignIn(
  client: GoogleSignInClient,
  redirectTo: string
): Promise<GoogleSignInResult> {
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: { prompt: "select_account" },
      },
    });

    if (error) {
      console.error("【登入】啟動 Google 登入失敗:", {
        category: "google_sign_in_failed",
        timestamp: new Date().toISOString(),
      });
      return { error: GENERIC_ERROR_MESSAGE };
    }

    return { error: null };
  } catch {
    console.error("【登入】啟動 Google 登入時發生例外:", {
      category: "google_sign_in_failed",
      timestamp: new Date().toISOString(),
    });
    return { error: GENERIC_ERROR_MESSAGE };
  }
}

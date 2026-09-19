/**
 * PKCE callback：Email magic link 與 Google OAuth 共用同一個 `code` 交換 session、
 * 寫 cookie、導回原本要去的頁面的路徑。
 *
 * server client 用 `createSupabaseServerClient()`（`src/lib/supabase/server.ts`）：
 * 它內部直接對 `next/headers` 的 `cookies()` 呼叫 `.set(...)`，在 Route Handler 這種
 * 「可以寫 response cookie」的情境下，Next.js 會自動把這些 Set-Cookie 帶到這個
 * handler 最後回傳的 `NextResponse` 上。
 *
 * OAuth provider 回傳的拒絕／錯誤、缺少 `code`、`exchangeCodeForSession` 失敗，三種情況
 * 都導回登入頁並帶一組固定、不外洩內部細節的 `error` 代碼（見 `@/lib/auth/errorCodes`），
 * 同時保留原本已驗證過的 `redirect` 目標，讓使用者重新登入成功後還是能回到原本要去的
 * 頁面（例如 MCP 的 `/oauth/consent?authorization_id=...`）。絕對不能把 PKCE 的
 * `code`、session token 或其他敏感值寫進任何 log。
 */

import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveSafeRedirect } from "@/lib/auth/safeRedirect";
import type { AuthErrorCode } from "@/lib/auth/errorCodes";

function redirectToSignIn(origin: string, errorCode: AuthErrorCode, redirectTo: string): NextResponse {
  const url = new URL("/auth/sign-in", origin);
  url.searchParams.set("error", errorCode);
  url.searchParams.set("redirect", redirectTo);
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const redirectTo = resolveSafeRedirect(requestUrl.searchParams.get("redirect"));

  const providerError = requestUrl.searchParams.get("error");
  if (providerError) {
    console.error("【登入】OAuth provider 回傳錯誤或使用者取消授權:", {
      category: "oauth_denied",
      timestamp: new Date().toISOString(),
    });
    return redirectToSignIn(requestUrl.origin, "oauth_denied", redirectTo);
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    return redirectToSignIn(requestUrl.origin, "oauth_missing_code", redirectTo);
  }

  try {
    const supabase = await createSupabaseServerClient();

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("【登入】交換 session 失敗:", {
        category: "oauth_exchange_failed",
        timestamp: new Date().toISOString(),
      });
      return redirectToSignIn(requestUrl.origin, "oauth_exchange_failed", redirectTo);
    }

    const response = NextResponse.redirect(new URL(redirectTo, requestUrl.origin));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    console.error("【登入】callback 處理失敗:", {
      category: "oauth_exchange_failed",
      timestamp: new Date().toISOString(),
    });
    return redirectToSignIn(requestUrl.origin, "oauth_exchange_failed", redirectTo);
  }
}

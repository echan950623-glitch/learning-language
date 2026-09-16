/**
 * PKCE magic-link callback：把 `code` 換成 session、寫 cookie、導回原本要去的頁面。
 *
 * server client 用 A 交付的 `createSupabaseServerClient()`（`src/lib/supabase/server.ts`）：
 * 它內部直接對 `next/headers` 的 `cookies()` 呼叫 `.set(...)`，在 Route Handler 這種
 * 「可以寫 response cookie」的情境下，Next.js 會自動把這些 Set-Cookie 帶到這個
 * handler 最後回傳的 `NextResponse` 上，不需要自己另外組一個帶自訂 cookies 回呼的
 * server client（原本 A 的檔案還沒就緒時，這裡暫時自己兜過一份，現在直接改用正式版）。
 */

import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/** 只接受站內相對路徑，避免被拿來當開放重導向使用。 */
function safeRedirectPath(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const redirectTo = safeRedirectPath(requestUrl.searchParams.get("redirect"));

  if (!code) {
    return NextResponse.redirect(new URL("/auth/sign-in", requestUrl.origin));
  }

  try {
    const supabase = await createSupabaseServerClient();

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("【登入】交換 session 失敗:", {
        message: error.message,
        timestamp: new Date().toISOString(),
      });
      return NextResponse.redirect(new URL("/auth/sign-in", requestUrl.origin));
    }

    return NextResponse.redirect(new URL(redirectTo, requestUrl.origin));
  } catch (error) {
    console.error("【登入】callback 處理失敗:", {
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    return NextResponse.redirect(new URL("/auth/sign-in", requestUrl.origin));
  }
}

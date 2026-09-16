/**
 * OAuth 2.1 授權同意頁的決定路由：接收 `src/app/oauth/consent/page.tsx` 表單送出的
 * `authorization_id`／`decision`，呼叫 Supabase 的 `approveAuthorization`／
 * `denyAuthorization`，再把使用者導回 OAuth client 的 redirect_uri。
 *
 * `skipBrowserRedirect: true`：這裡是伺服器端的 Route Handler，不是瀏覽器環境，明確要求
 * SDK 回傳 `redirect_url` 字串、自己決定怎麼導頁（`NextResponse.redirect`），而不是依賴
 * SDK 內部對「瀏覽器」的隱含假設。
 */
import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function badRequest(message: string): Response {
  return NextResponse.json({ error: "invalid_request", error_description: message }, { status: 400 });
}

export async function POST(req: Request): Promise<Response> {
  let authorizationId: string | null = null;
  let decision: string | null = null;

  try {
    const formData = await req.formData();
    authorizationId = formData.get("authorization_id")?.toString() ?? null;
    decision = formData.get("decision")?.toString() ?? null;
  } catch (error) {
    console.error("【OAuth 授權決定】解析表單失敗:", {
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    return badRequest("無法解析表單內容");
  }

  if (!authorizationId) {
    return badRequest("缺少 authorization_id");
  }
  if (decision !== "approve" && decision !== "deny") {
    return badRequest("decision 必須是 approve 或 deny");
  }

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const redirectTarget = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
    return NextResponse.redirect(new URL(`/auth/sign-in?redirect=${encodeURIComponent(redirectTarget)}`, req.url));
  }

  try {
    const { data, error } =
      decision === "approve"
        ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });

    if (error) throw error;
    return NextResponse.redirect(data.redirect_url);
  } catch (error) {
    console.error("【OAuth 授權決定】處理授權決定失敗:", {
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string } | null)?.code,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json({ error: "server_error", error_description: "處理授權決定時發生錯誤" }, { status: 500 });
  }
}

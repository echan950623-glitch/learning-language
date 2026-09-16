/**
 * `/mcp` 的請求層驗證：抽取 `Authorization: Bearer <token>` → 用只帶 publishable key
 * 的 client 呼叫 `supabase.auth.getUser(token)` 驗證 → 成功的話建立「這次請求專用、
 * 帶著該 token」的 Supabase client，讓 Postgres RLS 用 `auth.uid()` 自動限定成這個
 * 使用者。**絕對不會**在這裡用 `SUPABASE_SECRET_KEY`／service role 建立任何 client——
 * 那會繞過 RLS，等於幫每個 MCP client 開後門。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabasePublicConfig } from "@/lib/supabase/client";
import { getRequestOrigin } from "./requestOrigin";

export interface McpAuthContext {
  /** 這次請求專用、帶著使用者 access token 的 Supabase client；RLS 會自動只放行這個使用者的資料。 */
  supabase: SupabaseClient;
  userId: string;
  accessToken: string;
}

export type McpAuthResult = { ok: true; context: McpAuthContext } | { ok: false; response: Response };

function buildWwwAuthenticateHeader(req: Request): string {
  const origin = getRequestOrigin(req);
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

function unauthorizedResponse(req: Request, message: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", error_description: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": buildWwwAuthenticateHeader(req),
    },
  });
}

function serverErrorResponse(message: string): Response {
  return new Response(JSON.stringify({ error: "server_error", error_description: message }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * 驗證 `/mcp` 收到的請求並建立 RLS-scoped 的 Supabase client。
 * 失敗時回傳的 `response` 已經是完整、可以直接回給呼叫端的 401（含正確的
 * `WWW-Authenticate` header）或 500。
 */
export async function authenticateMcpRequest(req: Request): Promise<McpAuthResult> {
  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, response: unauthorizedResponse(req, "缺少 Authorization: Bearer <token> header") };
  }

  let url: string;
  let publishableKey: string;
  try {
    ({ url, publishableKey } = getSupabasePublicConfig());
  } catch (error) {
    console.error("【MCP 驗證】環境變數設定錯誤:", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });
    return { ok: false, response: serverErrorResponse("伺服器設定錯誤") };
  }

  try {
    const verifierClient = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await verifierClient.auth.getUser(token);

    if (error || !data.user) {
      return { ok: false, response: unauthorizedResponse(req, "access token 無效或已過期") };
    }

    const scopedClient = createClient(url, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    return { ok: true, context: { supabase: scopedClient, userId: data.user.id, accessToken: token } };
  } catch (error) {
    console.error("【MCP 驗證】呼叫 Supabase 驗證 token 失敗:", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });
    return { ok: false, response: unauthorizedResponse(req, "驗證 access token 時發生錯誤") };
  }
}

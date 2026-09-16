/**
 * RFC 9728（OAuth 2.0 Protected Resource Metadata）／MCP 授權規範要求的探索端點：
 * MCP client 收到 `/mcp` 的 401 + `WWW-Authenticate` 後，會先讀這裡找出授權伺服器位置，
 * 再去讀 Supabase 自己的 `/.well-known/oauth-authorization-server/auth/v1`。
 */
import { getRequestOrigin } from "@/lib/mcp/requestOrigin";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    console.error("【oauth-protected-resource】缺少環境變數:", {
      message: "NEXT_PUBLIC_SUPABASE_URL is not set",
      timestamp: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ error: "server_error", error_description: "伺服器設定錯誤" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const origin = getRequestOrigin(req);
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [`${supabaseUrl}/auth/v1`],
  });
}

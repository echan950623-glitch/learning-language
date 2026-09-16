/**
 * MCP endpoint。Node runtime（不是 Edge——這個專案的 Vercel 指引預設走 Node/Fluid
 * Compute）。用 `@modelcontextprotocol/sdk` 的 `WebStandardStreamableHTTPServerTransport`
 * （Web Standard Request/Response，正好對應 Next.js Route Handler 的簽名）搭配
 * `McpServer`，每個請求都建立全新的 server／transport 實例（stateless 模式：
 * `sessionIdGenerator: undefined`）——這裡沒有長駐的 session 狀態，每次請求各自獨立驗證
 * 身分、各自建立 RLS-scoped 的 Supabase client，很自然地對應 serverless 的無狀態特性。
 *
 * 用法比照 SDK 自帶的 Hono Web Standard 範例
 * （`node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/honoWebStandardStreamableHttp.js`）：
 * 建立 transport → `server.connect(transport)` → `transport.handleRequest(req)` 直接
 * 回傳 Response，不需要額外呼叫 `close()`（stateless、每個請求各自的實例，交給 GC 回收）。
 *
 * `enableJsonResponse: true`：四個工具都是快速的單次資料庫查詢／寫入，沒有伺服器主動推播
 * 的通知或長時間任務，用 JSON 回應比預設的 SSE 串流更適合 serverless（不需要維護
 * keep-alive frame、回應一次性就緒即可結束這次 function 呼叫）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { authenticateMcpRequest } from "@/lib/mcp/auth";
import * as addVocabularyBatch from "@/lib/mcp/tools/addVocabularyBatch";
import * as getLearningContext from "@/lib/mcp/tools/getLearningContext";
import * as getVocabularyInventory from "@/lib/mcp/tools/getVocabularyInventory";
import * as previewVocabularyBatch from "@/lib/mcp/tools/previewVocabularyBatch";

export const runtime = "nodejs";

const SERVER_INFO = { name: "learning-language-mcp", version: "1.0.0" };

/**
 * 每個工具都用 `structuredContent`（給支援 outputSchema 的 host）＋一份 JSON 文字版的
 * `content`（給只讀 content、尚未支援 structuredContent 的 host）雙重輸出，提高相容性。
 */
function toCallToolResult(result: unknown) {
  return {
    structuredContent: result as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function buildMcpServer(supabase: SupabaseClient, userId: string): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    getLearningContext.name,
    {
      title: getLearningContext.title,
      description: getLearningContext.description,
      inputSchema: getLearningContext.inputSchema,
      outputSchema: getLearningContext.outputSchema,
      annotations: getLearningContext.annotations,
    },
    async (args) => toCallToolResult(await getLearningContext.handler(supabase, args))
  );

  server.registerTool(
    getVocabularyInventory.name,
    {
      title: getVocabularyInventory.title,
      description: getVocabularyInventory.description,
      inputSchema: getVocabularyInventory.inputSchema,
      outputSchema: getVocabularyInventory.outputSchema,
      annotations: getVocabularyInventory.annotations,
    },
    async (args) => toCallToolResult(await getVocabularyInventory.handler(supabase, args))
  );

  server.registerTool(
    previewVocabularyBatch.name,
    {
      title: previewVocabularyBatch.title,
      description: previewVocabularyBatch.description,
      inputSchema: previewVocabularyBatch.inputSchema,
      outputSchema: previewVocabularyBatch.outputSchema,
      annotations: previewVocabularyBatch.annotations,
    },
    async (args) => toCallToolResult(await previewVocabularyBatch.handler(supabase, args))
  );

  server.registerTool(
    addVocabularyBatch.name,
    {
      title: addVocabularyBatch.title,
      description: addVocabularyBatch.description,
      inputSchema: addVocabularyBatch.inputSchema,
      outputSchema: addVocabularyBatch.outputSchema,
      annotations: addVocabularyBatch.annotations,
    },
    async (args) => toCallToolResult(await addVocabularyBatch.handler(supabase, userId, args))
  );

  return server;
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateMcpRequest(req);
  if (!auth.ok) return auth.response;

  const server = buildMcpServer(auth.context.supabase, auth.context.userId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}

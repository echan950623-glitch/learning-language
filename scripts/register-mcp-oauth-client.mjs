#!/usr/bin/env node
/**
 * 一次性腳本：註冊這個 MCP server 專用、唯一一個 confidential OAuth client。
 *
 * 執行前置條件（人工，這個腳本沒辦法自己完成，需要 Dashboard 存取權限）：
 * 1. Supabase Dashboard → Authentication → OAuth Server → 啟用（目前是 beta 功能）。
 * 2. 同一頁把 Authorization Path 設定為 `/oauth/consent`
 *    （對應 src/app/oauth/consent/page.tsx）。
 * 3. 確認 .env.local 裡的 SUPABASE_URL／SUPABASE_SECRET_KEY 指向同一個專案。
 *
 * 用法：
 *   node scripts/register-mcp-oauth-client.mjs <redirect_uri> [<redirect_uri> ...]
 *
 * 結果（client_id／client_secret）會寫進 gitignored 的 .mcp-oauth-client.local.json，
 * 不會印到 stdout／stderr——client_secret 是真正的憑證，不能留在終端機紀錄或 log 裡。
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import path from "node:path";

process.loadEnvFile(".env.local");

const CLIENT_NAME = "learning-language-mcp";
const OUTPUT_PATH = path.resolve(process.cwd(), ".mcp-oauth-client.local.json");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`缺少環境變數 ${name}，請確認 .env.local 已設定。`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const redirectUris = process.argv.slice(2);
  if (redirectUris.length === 0) {
    console.error(
      "用法: node scripts/register-mcp-oauth-client.mjs <redirect_uri> [<redirect_uri> ...]\n" +
        "例如: node scripts/register-mcp-oauth-client.mjs https://claude.ai/api/mcp/auth_callback"
    );
    process.exit(1);
    return;
  }

  const url = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");

  const adminClient = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 先用一次唯讀的 list 呼叫確認 OAuth Server beta 功能是否已經在 Dashboard 開啟，
  // 而不是直接嘗試 create——這樣未啟用時可以給出清楚的中文訊息與後續步驟，
  // 而不是丟出一個看不懂的 API 錯誤就結束。
  let existingClients;
  try {
    const { data, error } = await adminClient.auth.admin.oauth.listClients();
    if (error) throw error;
    existingClients = data.clients;
  } catch (error) {
    console.error("【註冊 MCP OAuth Client】無法列出既有 OAuth clients，OAuth Server 功能可能尚未啟用:", {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code,
      status: error?.status,
      timestamp: new Date().toISOString(),
    });
    console.error(
      "\n請先完成以下手動步驟，再重新執行這個腳本：\n" +
        "1. 前往 Supabase Dashboard → Authentication → OAuth Server\n" +
        "2. 啟用 OAuth Server（目前是 beta 功能，需要手動開啟）\n" +
        "3. 將 Authorization Path 設定為 /oauth/consent\n" +
        "4. 確認 .env.local 裡的 SUPABASE_URL／SUPABASE_SECRET_KEY 是同一個專案\n"
    );
    process.exit(1);
    return;
  }

  const duplicate = existingClients.find((client) => client.client_name === CLIENT_NAME);
  if (duplicate) {
    console.error(
      `已經存在名為 "${CLIENT_NAME}" 的 OAuth client（client_id: ${duplicate.client_id}），` +
        "為避免重複註冊，這次不會建立新的 client。如果需要重新產生 client_secret，" +
        "請改用 Supabase Dashboard 或 admin API 的 regenerateClientSecret，不要重新執行這支腳本。"
    );
    process.exit(1);
    return;
  }

  try {
    const { data, error } = await adminClient.auth.admin.oauth.createClient({
      client_name: CLIENT_NAME,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    if (error) throw error;

    writeFileSync(
      OUTPUT_PATH,
      JSON.stringify(
        {
          client_id: data.client_id,
          client_secret: data.client_secret,
          redirect_uris: data.redirect_uris,
          created_at: data.created_at,
          note: "這個檔案含有真正的 OAuth client secret，已經被 .gitignore 排除，不要手動加入版本控制或分享出去。",
        },
        null,
        2
      ),
      { mode: 0o600 }
    );

    console.log(`OAuth client 建立成功，client_id／client_secret 已寫入 ${OUTPUT_PATH}`);
  } catch (error) {
    console.error("【註冊 MCP OAuth Client】建立 OAuth client 失敗:", {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code,
      timestamp: new Date().toISOString(),
    });
    process.exit(1);
  }
}

main();

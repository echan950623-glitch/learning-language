# Supabase：migrations 與如何套用

這個目錄只放 DB schema／RLS／RPC 的 SQL migration，對應
[`ARCHITECTURE.md`](../ARCHITECTURE.md)「雲端化架構（2026-09-16）：Supabase 同步、Auth、
MCP」章節的凍結合約。專案的 Supabase 專案是 Tokyo region，project ref
`yhtxddaiofasliaflqqr`。

## 目錄結構

```
supabase/
  migrations/
    20260916010000_cloud_sync_tables.sql       建 5 張表＋索引＋開 RLS（enable + force）
    20260916020000_cloud_sync_rls_policies.sql 16 條 RLS policy
    20260916030000_cloud_sync_rpc_functions.sql record_graded_attempt／mark_attempt_correct
  README.md                                    這份文件
```

三個檔案依檔名（timestamp 前綴）順序套用，彼此有相依關係（policy 依賴表存在、函式內容
引用表與欄位），**不能跳過順序單獨套用某一個檔案**。

## 這個專案沒有已連結的 `supabase` CLI

跑過 `supabase --version`（找不到指令）與 `npx --no-install supabase --version`（本機
沒有快取套件、且不能互動安裝），確認這個環境沒有可用、已連結、已認證的 Supabase CLI，
也沒有嘗試 `supabase login`（需要互動式瀏覽器登入）。因此下面的做法**不是**
`supabase db push`，而是直接用 `pg` 套件連線執行 SQL——這也是
`ARCHITECTURE.md` 測試策略小節本來就預期的主要路徑（不依賴 CLI 是否可用）。

## 如何（重新）套用這些 migration

前提：`.env.local`（gitignored）裡有 `POSTGRES_URL_NON_POOLING`（直連用，DDL 一定要用
這個，不要用會經過 pgbouncer transaction-mode 的 `POSTGRES_URL`）。

這個專案的 `POSTGRES_URL_NON_POOLING` 實際指向 Supavisor 的 **session mode** pooler
（`aws-0-ap-northeast-1.pooler.supabase.com:5432`，不是傳統的 `db.<ref>.supabase.co`
直連位址）——這是目前 Supabase 專案預設提供的連線字串形態，session mode 一樣完整支援
DDL、`SET LOCAL`、多語句 transaction，跟真正的直連在這裡的用途上沒有差異。

**已知環境問題與修正**：這個 Node／`pg`（`^8.23.0`）版本組合下，直接用
`POSTGRES_URL_NON_POOLING`（內含 `sslmode=require`）連線會出現
`self-signed certificate in certificate chain` 錯誤。原因是新版 `pg-connection-string`
暫時把 `require`／`prefer`／`verify-ca` 都當成 `verify-full` 處理（會驗證憑證鏈），而不是
libpq 原本「`require` 只加密、不驗證憑證」的語意；套件本身在連線時的 warning 訊息也會
說明這件事。修法是在連線字串加一個 query 參數，切回 libpq 相容語意：

```js
process.loadEnvFile(".env.local");
const { Client } = require("pg");

const base = process.env.POSTGRES_URL_NON_POOLING;
const sep = base.includes("?") ? "&" : "?";
const client = new Client({ connectionString: base + sep + "uselibpqcompat=true" });
```

**套用（或重新套用）全部 migration**（在專案根目錄執行；三個檔案包在同一個 transaction
裡，任何一個檔案出錯就整個 rollback，不會留下部分套用的狀態）：

```js
// scratch 腳本，用 `node -e "$(cat <<'EOF' ... EOF)"` 或存成暫存檔執行，不需要留在專案裡
process.loadEnvFile(".env.local");
const fs = require("fs");
const { Client } = require("pg");

(async () => {
  const base = process.env.POSTGRES_URL_NON_POOLING;
  const sep = base.includes("?") ? "&" : "?";
  const client = new Client({ connectionString: base + sep + "uselibpqcompat=true" });

  const files = [
    "supabase/migrations/20260916010000_cloud_sync_tables.sql",
    "supabase/migrations/20260916020000_cloud_sync_rls_policies.sql",
    "supabase/migrations/20260916030000_cloud_sync_rpc_functions.sql",
  ];

  await client.connect();
  await client.query("begin");
  try {
    for (const f of files) {
      await client.query(fs.readFileSync(f, "utf8"));
    }
    await client.query("commit");
    console.log("OK");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    await client.end();
  }
})();
```

**冪等性**：
- `20260916010000`（建表）**不是**冪等的——`create table` 沒有 `if not exists`。在全新
  專案上第一次套用即可；如果之後要「重來一次」，要先手動 `drop table ... cascade`
  （沒有寫自動 drop script，避免誤刪 production 資料——這是刻意的保守設計）。
- `20260916020000`（RLS policy）**不是**冪等的——`create policy` 沒有
  `or replace`／`if not exists`。重跑會因為 policy 名稱already exists 而報錯；要重跑
  必須先 `drop policy` 或整個表重建。
- `20260916030000`（RPC 函式）**是**冪等的——用 `create or replace function`，加上
  `revoke`／`grant`／`comment on` 也都是安全重複執行的陳述式。這個檔案在開發過程中
  被重新套用過一次（修正 `record_graded_attempt` 的冪等短路順序，見下方「已知偏離」），
  重新執行完全安全。

## 驗證套用結果

不要只看「腳本沒有丟例外」，要實際查 `information_schema`／`pg_catalog`：

```sql
-- 5 張表都存在，RLS 兩個旗標都是 true
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('learning_items','schedule_states','study_sessions','review_attempts','user_preferences');

-- 應該剛好 16 條 policy（learning_items 4 條；schedule_states／review_attempts 各 3 條；
-- study_sessions／user_preferences 各 3 條）
select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public';

-- 兩個函式都應該是 security invoker（prosecdef = false）
select proname, prosecdef, proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname in ('record_graded_attempt','mark_attempt_correct');
```

## 跑真實 DB 的 RLS／RPC 測試

```
npm run test:supabase
```

這只會跑 `src/lib/supabase/**/*.test.ts`（目前是 `rls.test.ts`），不影響 `npm test`
（全套快速單元測試）的執行時間。沒有 `.env.local`／`SUPABASE_SECRET_KEY` 時這個測試檔會
`describe.skip` 整組，`npm test` 仍然會成功跑完，只是略過這個檔案。

測試內容：跨使用者隔離（两个 admin API 建立的臨時帳號）、`client_id` claim 限制模擬
（用 `pg` 直連＋`SET LOCAL ROLE authenticated`＋`set_config('request.jwt.claims', ...)`）、
`record_graded_attempt` 的冪等性與原子性拒絕、`mark_attempt_correct` 的「拒絕修正已被更新
排程覆蓋的舊 attempt」規則。測試建立的臨時帳號與資料在 `afterAll` 一律清除（刪除
`auth.users` 列會 cascade 清掉其餘表的關聯列）。

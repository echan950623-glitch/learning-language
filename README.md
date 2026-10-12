# 語言學習 App

Next.js 16 / React 19 / TypeScript 的日文與英文學習 App。使用本機優先的學習資料與 Supabase 同步，GPT 透過 MCP 預覽並新增教材；App 作答時不呼叫模型 API。

## 雲端 workspace 開發

使用 Node.js 24 與 npm，從 `main` 開始：

```sh
npm ci
npm run dev
```

檢查命令：

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

憑證未提交。需要雲端同步、OAuth 或 MCP 整合時，請在 workspace 的 secret store 或 Git 忽略的 `.env.local` 設定環境變數；參考 `src/lib/supabase` 與 MCP/OAuth 的設定檢查。不要把真實帳戶備份、token 或 `.env` 提交。部分外部整合測試需要另外設定測試憑證；預設跳過不代表正式環境驗收。

## 接續工作（2026-10-12）

- 正式站：https://learning-language-three.vercel.app/
- 英文功能已發布，Production deployment：`dpl_8s8ox6twAwr14xY6SrS9AMc6iRQ4`；PWA shell v30。
- 英文 migration 已套用至正式 Supabase，正式版本 `20261012063734`，名稱 `english_meaning_practice`。本機來源是 `supabase/migrations/20261012053822_english_meaning_practice.sql`。
- 歷史 migration 透過 MCP 套用，正式版本時間戳可能與本機不同。對正式資料庫執行 CLI migration 前，先按名稱及 SQL 核對歷史，不要直接重新套用全部 migration。
- 已經透過使用者確認的 MCP 匯入 available、confirm、arrange、delay、request；每個字有五題，新增狀態為 new。不要為驗收虛構作答或改動真實學習紀錄。
- 本機驗證：619 passed / 22 skipped，lint、typecheck、build 通過。正式手機尺寸訪客頁面檢查通過；真實登入作答同步、跨裝置及實體手機 PWA 仍待驗收。
- 定時內容檢查與學習評估尚未實作，請先規劃再開始。

參考 [產品規格](PRODUCT_SPEC.md)、[架構](ARCHITECTURE.md)、[英文功能](docs/english-practice.md) 與 [英文原審核計畫](docs/english-practice-implementation-plan.md)。

教材來源在 `src/domain/*Catalog.ts`。可用 `node scripts/export-english-content.mjs` 與 `node scripts/export-jlpt-content.mjs` 重新產生匯入批次；`output/` 是忽略的產物目錄。

## 資料與發布原則

保留現有 StudySession、SRS、作答證據與 FIFO outbox 的語意。不要刪除歷史、清空 outbox 或將跳過當成答對來製造成功。新增同步操作需要一起檢查 repository、outbox、SQL guard、migration 與 PWA 快取版本。

正式部署、migration、commit/push 與真實帳戶寫入須有對應授權。Git push 可能觸發 Vercel 自動部署，部署結果需另外核對。Next.js 寫程式前請依 AGENTS.md 閱讀安裝版本的本機 docs。

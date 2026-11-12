# 語言學習 App

Next.js 16 / React 19 / TypeScript 的日文與英文學習 App。使用本機優先的學習資料與 Supabase 同步，GPT 透過 MCP 預覽並新增教材；App 作答時不呼叫模型 API。

## Claude 接手（2026-11-11）

先讀 [Claude 交接說明](docs/claude-handoff.md)。整合 11 月正式站同步修正與 10 月未入 Git 的題型對齊、登出入口和首頁文字精簡；PWA shell v37。使用 Node.js 24（`.nvmrc`）；雲端同步設定參考 `.env.example`。

驗收：乾淨 `npm ci`、lint、型別檢查、666 項測試與正式建置通過；22 項外部測試略過。詳見交接文件的驗證紀錄。

## 新字額度與分輪（2026-11-11）

新字專區改用設定頁的「每日新字上限」（0、5、10、15、20、30、50，預設 5），不再把偏好覆寫成 50；每輪引入約 5 個新字，做完再開下一輪。雲端預約仍取帳戶偏好與請求值的較小者，不需 migration。

## 介面改版（2026-11-12）

墨色單色搭配朱紅強調色、細線分隔取代卡片框；學習中的字用明朝體大字顯示。只改樣式與版面，學習規則、排程與同步不變。色彩與字體集中在 `src/app/globals.css`。PWA shell v39。

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

## 接續工作（2026-11-05）

- 已接續改善每次開啟的載入速度：有本機內容先使用、背景檢查雲端 revision、相同版本不重抓資料表、合併重疊下載，並減少大快照複製與不必要的 IndexedDB 寫入；PWA shell v36。663 passed／22 skipped，lint、typecheck、build 與原同步恢復演練通過，詳見 [載入與同步效能](docs/loading-performance.md)。
- 上一個正式部署為 `dpl_CSjFJFrW7U2hiXvkFraDt4HTE6mv`，來源 `efc91f0`，已核對首頁 HTTP 200／PWA v35；以下整合版交付數字保留作基準，最新發布以 Vercel 實際提交版本為準。

- 已整合題目位置衝突恢復、新字額度獨立預約、英文 meaning 排程、防延遲點擊，以及一般上傳等待網路時不阻擋本機作答；PWA shell v35。
- 本機 lint、typecheck、build 通過，658 passed／22 skipped。完整備份在隔離 PostgreSQL 演練：41 筆待送操作全部完成，885 筆原作答逐欄保留，後續新字預約核准 50 筆；沒有修改正式學習資料。手機尺寸訪客入口、作答防連點及重整續接亦通過。
- 11/3 正式站有未入 Git 的操作改善。本整合版已取回原版防點擊守門，並重新實作、驗證一般同步不阻擋本機作答的行為，詳見 [同步調查與整合交付](docs/sync-question-conflict.md)。同步恢復版已發布，個別裝置仍須載入新版後驗收。
- 22 個外部測試未執行；真實登入、跨裝置與實體手機 PWA 尚待新版驗收。不需新增 migration。定時內容檢查與學習評估仍未實作。

### 先前發布基準（2026-10-12）

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

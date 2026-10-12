# 英文單字與片語練習（本機交付）

日期：2026-10-12。已部署 Production、已套用英文 migration；教材尚未寫入真實學習帳戶。

## 使用方式

首頁右側切換英文。GPT 準備指定詞義、詞性與題目變體，先呼叫 preview_vocabulary_batch，再於使用者確認後呼叫 add_vocabulary_batch(confirm=true)。App 不呼叫 AI，也不需要模型 API Key。

第一版只練直接辨義與句中辨義四選一，不把選擇答案解讀成拼字、口說或聽力能力。新字先介紹指定用法與代表例句，再依今日額度開始。英文與日文各自使用每日新字名單、session、作答與排程。

- /study?language=en：英文學習；既有未帶參數 /study 維持日文。
- /progress?language=en：英文單字庫與理解證據，支援搜尋、分類／類型／狀態篩選，以及確認後暫停／恢復。
- 句子與選項在 session 建立時凍結；重新整理與繼續不換題。
- 後續到期輪替直接／情境辨義；情境題優先未曝光內容，新字介紹展示的代表句也算曝光。
- 預留題只供延後驗證；耗盡變體時不宣稱新情境。換 ID、換選項順序或文字大小寫不算新題。
- 每種題型各自需要到期首次、無提示、跨日且至少七天間隔的成功；情境還需要至少兩個不同題目。兩種題型都通過才標示穩定理解，再安排 30／60 天確認。
- 提示與當輪重試保留原始紀錄，不造熟練。英文固定選項題不提供「我其實答對了」覆寫。
- 原始 status 欄位保留相容用途；英文理解狀態以目前內容的實際 evidence 投影為準。

## 首批教材與 MCP 格式

src/domain/englishPracticeCatalog.ts：30 個原創指定用法（20 個單字、10 個片語／搭配），每項 1 個直接辨義與 4 個情境，共 150 個題目。不是官方多益題庫或完整課程。

執行 `node scripts/export-english-content.mjs` 可重新產生 output/english-mcp-batches/batch-1.json 至 batch-3.json，每批 10 項、不帶 confirm=true、不含帳戶或作答資料。這些檔案是 preview/add 的 items payload，不能直接當備份還原。

englishPractice 格式見原實作計畫與 MCP schema。內容新增時不得帶 activeVariantId；只有凍結題目快照可帶。格式、目標字串、唯一選項與重複題目有檢查，但無法自動保證英文語意與干擾選項品質，仍須內容審查。

舊英文項目未有變體時保留資料與歷史，顯示「待補練習內容」，不偷偷把舊回想紀錄改為新的辨義證據。補充／修訂既有內容的 MCP 與定時檢查不在本次範圍。

## 資料與 SQL

- 新增 meaning 能力，不挪用日文 recall/reading。
- englishPractice 存入既有 learning_metadata，往返於 MCP、本機、備份、session／attempt snapshot 與 outbox。
- 新 migration：supabase/migrations/20261012053822_english_meaning_practice.sql，由 CLI 建立檔案；本機 PGlite 執行全部 migration 驗證，未套用線上。
- SQL 包含 meaning 約束、英文內容／快照／答案 trigger、語言獨立 reservation，以及受 ownership、client_id 與原子事件守門保護的重播。
- 保留原日文事件守門；新的 language boundary 內委派給原事件函式，原函式撤除 authenticated 的直接執行權限。新驗證 helper 不讀取其他使用者資料，trigger 函式不公開執行。
- PWA shell v30。線上若只發布前端而未先套用 migration，英文同步會被拒絕；不能只看本機可作答就宣稱雲端已可用。

## 驗證證據

- 全套 Vitest：619 passed／22 skipped；跳過的真實外部測試不計通過。
- typecheck、lint、Next.js production build 通過。
- PGlite：英文新增、首次分類資料匯入、introduction／attempt 原子事件、快照保存、冪等、偽造答案拒絕、錯誤語言與跨帳戶拒絕；既有日文 SQL 測試通過。
- 本機 production build，localhost:3211 的隔離訪客測試：透過備份預覽／確認載入 5 英文＋1 日文的人工 fixtures，沒有真實帳戶資料。
- 手機 390×844：完成新字介紹、4 選 1、提示與 reload 保留、答錯與跨題重試、結算、進度、暫停／恢復。首輪 6 筆英文作答、1 次提示、1 次重試、5 筆英文排程，日文作答仍為 0。
- 隔離瀏覽器測試時鐘模擬下一個到期日：出到 context-2（跳過理解卡展示的 context-1），reload 固定相同句子與選項；再完成 5 題情境作答，結算 100%（5/5）。不把模擬日期當自然完成的跨日學習。
- 已快取頁面與題目在強制離線 reload 後仍可使用。線上操作無 error/warn；離線測試另有未快取 favicon 的 ERR_INTERNET_DISCONNECTED，不影響題目或紀錄。
- 明暗模式畫面可辨讀，無水平溢出；output/playwright/english-context-mobile-light.png、english-context-mobile-dark.png、english-home-mobile.png、english-progress-mobile.png、english-summary-mobile.png。

## 後續發布與未驗證事項

1. 已於 2026-10-12 取得部署授權並發布；正式 migration 版本為 20261012063734（英文支援）。
2. 刷新 GPT 連接的 MCP 工具描述，確認英文新欄位可用；首批教材仍需預覽／確認後才加入真實帳戶。
3. 驗收真實 MCP OAuth、新增→同步→登入作答、跨裝置及實體手機 PWA。
4. 完成英文正式使用驗收後，再規劃定時內容檢查與學習評估。

本機測試／SQL 模擬不是 Production、真實登入、跨裝置或手機 PWA 的驗收證據。未 commit/push；新增程式與教材的唯一可編輯副本在本機。

## 2026-10-12 14:40 英文練習正式部署
- 使用者授權「部署」。Supabase yhtxddaiofasliaflqqr 套用 english_meaning_practice，正式版本 20261012063734；四個英文 trigger 啟用、meaning constraints 已生效，anon execute=false、authenticated=true、舊內部函式直接 execute=false，無教材/學習紀錄匯入。
- Vercel Production dpl_8s8ox6twAwr14xY6SrS9AMc6iRQ4 READY，alias https://learning-language-three.vercel.app/；遠端 build 成功，從已驗證的 dirty checkout 部署，未 commit/push。
- 正式 390x844 訪客檢查：日英切換、英文空狀態與 /progress?language=en 正常，無橫向溢出；console 0 errors/0 warnings。正式 sw.js v30。近 10 分鐘 runtime error 查詢無紀錄（有限觀測）。
- Security advisor 僅回報既有 Auth leaked-password protection disabled，未改 Auth 設定。真實 OAuth/MCP 寫入、登入作答同步、跨裝置與實體 PWA 未驗證；定時檢查未建立。
- 下一步：刷新 GPT MCP 工具描述，預覽/確認首批英文教材，再驗收真實登入與跨裝置。新增程式的唯一可編輯副本仍在本機。

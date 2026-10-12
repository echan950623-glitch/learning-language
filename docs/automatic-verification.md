# 自動驗證學習方式（2026-10-11）

本次沿用 StudySession、到期首次作答證據、既有 JSONB 編輯事件及 FIFO outbox。2026-10-11 已依使用者授權將已測試的本機工作樹直接部署至 Production；未 commit／push。實體手機 PWA 與真實帳戶跨裝置仍未驗證。

## 使用者會看到

- 首頁直接開始今日學習，顯示實際這輪題數；系統替使用者挑選，不要求逐字自選。
- 每輪最多兩個到期的驗證能力，其餘排必要學習／補強。沒有足夠題目就短一輪，優先複習不再用未到期內容湊數。明確選擇全範圍仍可自行練習。
- 「這個已會，改為定期驗證」需兩次確認，500ms 內快速連按不算第二次。跳過該詞本輪未答題並提出驗證請求，不算答對；24 小時後起自動檢查。驗證題不能用相同按鈕繼續跳過。
- 舊的 reviewPaused=true 保持暫停，不自動恢復。原有恢復控制仍保留。
- 進度顯示跨日記憶、句中填空驗證、下一次確認日期。沒有合適情境題會明示尚無合適驗證題。

## 判斷與出題

1. 同一內容及同一能力，至少兩個不同學習日、到期首次、無提示的成功，且最近兩次成功實際相隔至少 7 天，才減少出題。
2. 下次自動確認為最後一次合格成功後 30 天；30 天以上再次成功後，下次為 60 天。這些數字及每輪兩題是產品預設，不是研究證明的通用熟練標準。
3. 整體原有五次穩定門檻保留；減少出題與「所有能力已熟練」分開。讀音和回想獨立，錯誤／提示使該能力回到原有補強排程，歷史不刪除。重試、同日／未到期正確及 legacy 無分類紀錄不增加證據。
4. 複習日期為從真實 attempts 推導的出題日期，沒有覆寫 SRS 基準或造出新的 schedule 成功。出題、首頁、今日計畫和進度使用同一推導。重大內容修改會排除舊內容證據。
5. N5/N4 的 40 個詞彙各有兩個原創平行情境句；用法驗證採句中原形填空，讀音採句中讀音。自訂詞若沒有適用句子，只檢查間隔後回想／讀音，不假稱已驗證用法。
6. 平行 practice 題至少三個版本時，保留末題給延遲驗證。已建立的 session 與已答題 snapshot 都視為曝光，避免中途重整換題、未作答也被重標全新。版本耗盡時誠實標為間隔後確認，不假稱新題。
7. 原有 JLPT 字彙包的 reading／orthography／meaning 是不同任務，三者各自有兩次跨日證據才降低整包頻率，不把讀音成功當成詞義成功，也不把其中一項封存成平行題。

## 資料與驗證

- 新增可選 autoVerificationRequestedAt，透過現有 LearningItem edit JSONB 寫入；snapshot 的 verificationQuestion 保存題目種類、原始提示、曝光鍵與 novel 標記。相容舊備份，不需資料表／RPC migration。
- 不修改帳戶、憑證或真實學習資料。本機瀏覽器採 localhost:3110 隔離 guest fixtures。
- 測試涵蓋 30/60 天、能力分離、不湊題、內容修改、曝光／保留題、請求不造證據、durable reload、outbox 順序／rollback、既有 SQL 事件冪等重播和實際作答 snapshot。
- 本機測試與 SQL 模擬不等於 Production 或 installed-phone 驗收。既有 N4/N5 題庫仍為原創備考素材，不是完整歷屆題庫，亦未新增聽力。

## 正式部署驗收（2026-10-11）

- Vercel Production：`dpl_8EA8y5i9REDsBhRUyf8gnL7mwpkY`，狀態 READY，正式別名 https://learning-language-three.vercel.app 已指向此部署。
- 直接 CLI 上傳本機工作樹，229 個部署檔案；環境檔、私人日誌及 output 由 .vercelignore 排除。平台顯示的 Git metadata 是原 HEAD，不代表此次未提交內容；以此部署 ID 與正式頁面驗收為準。
- 正式站隔離 guest 瀏覽器首頁 HTTP 200，新版自動安排說明已出現；390x844 無水平溢出，console 0 errors／0 warnings。原 v26 瀏覽器快取已切到唯一 `learning-language-shell-v28`，未寫入真實帳戶學習資料。
- 截圖：`output/playwright/automatic-verification-production-mobile.png`。本機 610 passed／22 skipped、lint／typecheck／build 通過；Vercel 建置與 TypeScript 亦通過。實體手機、登入後完整作答與跨裝置同步仍待驗收；此次不需新資料庫 migration。

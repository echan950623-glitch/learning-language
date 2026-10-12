# 日文學習閉環：實作與驗收
更新：2026-10-04（Asia/Taipei）。基底 main / 3721d43；直接部署未提交工作樹，未 commit 或 push。

## 已接入的規則
| 項目 | 實作 |
|---|---|
| 學習入口 | 今日／錯題／總複習／隨機共用 StudySession 與 /study；保留各模式範圍及可注入 Fisher–Yates |
| 收件匣 | 新增不建排程；理解卡含詞義、讀音、詞性、例句、說明；已經會了仍須回想 |
| 每日計畫 | 固定 Asia/Taipei 00:00，日期／語言／規則版本／內容／完成／理由持久化；預設 5 個不同新字，可設 0，既有明確設定保留 |
| 雲端額度 | 同帳戶同日交易式 reservation，跨裝置共用；未取得 reservation 的離線帳戶先做既有複習，不能自行發新額度；補讀音不重算 |
| 負荷 | 正常目標 15–20 分鐘，忙碌約 5 分鐘只做必要複習；每輪 5/10/15/20，due 優先，積欠可停止新字；不自動加量 |
| 新字回想 | 先批次理解再回想；少於 4 個理解項目且無其他題可穿插時，保存三分鐘間隔；明確已會可直接驗證 |
| 補強 | 想不起來可保存空白首答；正解及關鍵說明；隔 3 題插入補考，每能力每輪最多 2 次，尾端不足間隔不插入；錯了仍能結束 |
| 排程 v2 | [1,3,7,14,30] 天；到期首答無提示成功才延長；提示、補考、非到期同日自主成功不反覆推進；同輪 lapse 不重罰；新字成功隔天 |
| 能力證據 | recall／reading 獨立；5 次跨日到期無提示首答成功才穩定；近期 3 次失敗需要加強，後續可恢復；舊歷史不猜測 |
| 題目版本 | 文字題型標籤、精確正規化、假名及指定接受答案；指定漢字格式明示；原始／正規化答案、原判定、更正及原題快照保留 |
| 編輯 | 重大內容修改建立版本並要求重新理解，保留原作答與 lapse 歷史，重設未來證據；進行中的舊題仍可完成，但不推進新版能力 |
| 統計 | 到期首答無提示正確率、完整到期／本輪量、收藏／已開始、能力證據、七日天數與前景時間；首答與補考分開 |
| MCP | 完整分頁，提供規則版本、每日計畫及首答／提示／模式／補考證據；預覽確認新增保留，服務失效不影響既存學習 |

## 持久化、迁移及恢復
IndexedDB learning-language-atomic/accounts 的 owner envelope 是正本。store／outbox／偏好／alias／journal 於 Web Lock 內一次交易；中斷或 quota 不保存半份，RPC 前 flush 恢復證據。localStorage 是相容副本；mirror 失敗不能刪掉成功提交的正本。帳戶 generation 在寫入前驗證，登出保留原帳戶佇列。

舊 flat keys 原樣保留，只在訪客區讀取；登入不自動認領。設定提供明確認領至空帳戶，遇其他 owner 或已有目標內容即拒絕並保留資料。備份只匯出學習白名單，驗證版本、owner、內層操作、紀錄關聯及恢復 journal；同歸屬本機還原，預覽後新寫入使預覽失效，保留還原前副本，預設暫停同步，需另按恢復。

有歷史或無歷史項目統一封存，雲端 tombstone 傳播，保留 session／attempt／schedule。完整下載每頁 500，遠端 revision 前後一致才能提交，頁間變動最多重抓三次；本機期間新写入拒絕舊下載。前景／連線／手動及可見時 30 秒 revision 檢查通知 repository 與畫面。作答頁題目凍結。

新版事件以穩定 event ID 在雲端交易內提交 session／attempt／schedule／plan；重送相同事件只回 replay，不重算。不同裝置的拒絕事件先保存重放 journal，以全部同能力作答按時間重建，保留兩邊紀錄；未解決的同字內容衝突停止同步並保留佇列，不選邊、不丟事件。

## 正式 SQL（已授權、已套用）
| 本機 CLI 產生版本 | 遠端 migration 版本 | 名稱 |
|---|---|---|
| 20261002124554 | 20261003152949 | learning_archive_tombstones |
| 20261003013759 | 20261003152951 | stable_learning_snapshot |
| 20261003154437 | 20261003165705 | learning_events_and_daily_plans |
| 20261003170122 | 20261003170222 | allow_account_cascade_cleanup |

MCP apply_migration 使用遠端時間版本，不能直接 db push 假設歷史一致。database.types.ts 已由真實 schema 產生。revision trigger 修正 Auth cascade 刪除，避免重新插入已不存在 owner 的 revision。原有資料套用前後均 116 items／538 attempts／180 schedules／71 sessions；本輪臨時測試帳戶已清理，清理後回到同一數量。

## 實跑證據
- npm test：480 passed、22 skipped（56 通過檔、5 略過真實環境檔）；預設不建立雲端使用者。
- RUN_REAL_TESTS=1 npm run test:real：22 passed，包含真實 RLS／MCP／舊同步及新版兩裝置排程重放，所有測試使用臨時帳戶。
- 本機 PostgreSQL 實際執行全部 SQL；封存、RLS、MCP 禁止寫入、每日 quota、冪等事件、補考、版本編輯、Auth cascade 均通過。
- 超過 1,000：本機 1,201 筆；真實測試 1,003 筆完整下載，1,001 筆跨頁歷史重建 session；同日雙裝置首答保留兩筆，interval 只進到 3 天、evidenceStreak=1。
- 390×844 瀏覽器：五字理解→想不起來→提示→Enter→有限補考→結算，5 首答／2 補考，最大 lapse=1、stable=0；IME composition Enter 未誤送；提示及題目位置重新整理保留。
- 同日第二輪只补 3 題讀音，新字仍 5；離線 Enter 答題後重整為 2/3；離線 /settings 導覽及重開正確。離線 RSC 預取仍可能出現網路 console error，實際頁面／保存可用。
- 新增詞性／例句、單字編輯及精確可接受答案、0 新字及忙碌設定保存已在瀏覽器核對，沒有橫向溢出。
- typecheck／lint／build 通過；部署前最終檢查及公開站證據記錄於下方。

## 尚需真人驗收及限制
實體 iOS／Android 安裝 PWA、系統完全關閉／裝置重啟、真實日文鍵盤遮擋與跨裝置日常使用尚未驗證。固定 Taipei 時區目前不提供可任意切換的設定。已有內容帳戶的舊訪客合併採拒絕並保留，需另做人工核對，不自動跨帳戶覆寫。

後續範圍：句子填空／翻譯／造句與 AI 開放評分、聽力／語音、英文完整切片；本輪維持英文未開放。先連續使用七天，觀察完成天數、積欠與反覆失敗內容，再調整產品參數，不自動增加新字。

Supabase advisor 無新增資料表/RPC 安全問題，仍有原本 Auth leaked-password-protection WARN。npm audit 剩餘 eslint 開發相依 braces 鏈 5 high，官方無 patched version；未降版 Next 以清零。上述均未當成手機或全部 Production 驗收完成。

## Production 交付（2026-10-04 01:28）
- 正式網址：https://learning-language-three.vercel.app
- 最終 deployment：dpl_E9KF4N59NF96Rsr84VPxhejt4wXv，source=cli、target=production、READY，canonical alias 已獨立向 Vercel 查證。
- 公開站 390×844：5 個理解卡→想不起來→回想→補考→結算，5 首答／1 補考，正確率 4/5，沒有用補考墊高首答率。
- 隔離測試帳戶的公開 App：新增含詞性／例句項目→已會驗證→合理假名首答→明天複習，雲端 item／attempt／plan 各 1、interval=1、pending=0。
- 第二個獨立瀏覽器完整下載並補讀音，雲端 2 筆作答／2 個能力完成，新字配額仍 1。再做非到期隨機題，離線重開→作答→重連上傳，3 筆作答、pending=0、兩能力 interval 仍各 1 天。
- 直接冷開 /study 發現 auth／計畫初始化競跑，修正為等待帳戶選定、IDB hydrate 與首次下載，再建立計畫；回歸測試及新的全空瀏覽器實跑通過。
- SW v21 更新全路徑外殼；公開站實際確認 v21 cache，離線 /study 重開維持正確完成畫面，initError=false。明暗截圖及 computed color 核對，手機尺寸無橫向溢出；真實鍵盤未驗證。
- 此帳戶以合法測試 session cookie 載入來驗收登入後 App，未走 Google OAuth 或 Email 寄信登入；這兩個外部使用者流程仍未驗證。臨時 session 已全域登出、帳戶刪除、兩份 Git 忽略的臨時 credential 檔已刪除。
- 清理後正式資料仍 116／538／180／71，臨時驗收帳戶 0。不得將測試帳戶的作答當作使用者學習成果。
- 最終一般測試 480 passed／22 skipped；22 項真實環境測試通過；typecheck／lint／本機及 Vercel build 通過。部署 dry 已查私人檔案 0，沒有上傳登入 token、secret、私人 devlog 或瀏覽器產物。
- Git main／HEAD 3721d43，88 個工作樹變更項，未 commit／push；Vercel 顯示的 3721d43 是基底 metadata，不是本次完整程式版本。原始變更唯一可編輯副本在本機；部署保存的是已上傳 build。
- 後續不需額外 SQL 才能使用本輪功能。外部驗收集中在真實手機 PWA、背景／系統重啟、實體輸入法與 Google／Email 登入；先七日使用，觀察積欠與反覆失敗內容，再調整規則門檻。

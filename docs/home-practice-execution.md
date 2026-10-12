# 首頁練習操作調整（2026-10-08）

## 2026-10-08 13:55 選擇題與首頁放棄

- 首頁放棄在接續按鈕旁，確認／取消、ID核對與雙擊防重送；已完成答案及排程保留。形態頁新增現在進行／非過去／過去範圍快捷，篩選已學啟用形式，不包含動詞分類。
- 舊已存題及進行中的凍結題立即沿用新顯示規則：分類、規則、助詞、文法理解／情境、搭配、閱讀与指定語序重組可選擇；動詞產出／單字回想仍輸入。選項排除同題可接受答案別名、穩定排序；沒有可靠替代選項的自訂题不亂補選項。
- 不寫或改正式題目 metadata，不猜測新的已學範圍。選擇 production/usage 題使用現有 usedHint=true 標記選項協助，避免獨立回想或熟練度灌高；recognition 原能力照常。尚未有獨立 choice/text 統計欄位，提示率包含選項協助。
- 583 passed／22 skipped，typecheck/lint/build通過。新增7個domain選項／時態測試；本機390×844新guest注入既有20題fixture（僅localhost/owner:null），未寫正式帳戶。
- 實跑分類3選項／無文字框、reload保持同題、雙擊確認僅一筆作答；文法首答後首頁1/2顯示放棄、取消保留、確認雙擊後session abandoned且答案保留（2輪、2答未重複）。現在進行快捷→2個形式→填入正確變化Enter答對。
- 文法情境4選項／句構4／搭配3／閱讀3，均無文字框。選擇情境答對保存usedHint=true，自行變化答對保存false；閱讀真正離線reload選項相同。明暗截圖已檢視、無橫向溢出，SW v24。第一次fixture因新guest尚無快照而失敗，補明確空guest初始化後成功，未假算首次通過。
- 正式手機登入後畫面、IME與實體手機PWA更新尚未驗證；正式部署證據在下方補記。
- 正式 dpl_Ezdi6mSSWFGuiVHC8JYoJCrbPtW4：遠端 build、stage curl 200、promote 及 canonical inspect Ready 完成；dry 211 entries／205 actual files／private 0。公開 guest 手機尺寸首頁六類／無溢出，SW v24，真正斷網首頁→形態範圍→reload 成功。MCP兩頁重讀仍為150筆：130單字、20練習、156變體；未改正式題目／作答／排程、未commit/push。
- 深色截圖第一次在切換色系時抓到提示字尚未重繪；重新導航確認 computed foreground rgb(243,241,234) 並重截，提示及按鈕文字可讀。此輪沒有將公開guest空狀態驗證當作正式帳戶作答成功。

依使用者確認ASCII介面後授權「實作、部署」。保留main/3721d43既有未提交修改、已存内容和學習紀錄；沒有commit/push。

## 使用方式

- GPT預覽、你確認後，用MCP加入單字或已學過的練習。App不再提供新增、題庫加入、自訂題目或編輯表單；舊/add導回首頁。新訪客不自動注入範例；舊範例及其進度保留。
- 首頁六類：單字與漢字、形態變化、文法、助詞與句構、常見搭配、閱讀。直接開始，或進入選範圍。沒有內容只顯示尚無內容，請告訴GPT你想練什麼。
- 細選只顯示已學且啟用的概念；已有題型才提供理解／產出／應用或意思／讀音／混合。來源：優先複習、只做到期、錯題、全部已學。5/10/15/20只影響這輪，不覆寫帳戶題數偏好。
- 優先複習先排到期、再錯題、最後其他已學。自主練習沿用原排程，不反覆延長非到期題的間隔。收件匣單字從今日計畫引入；未排入每日計畫的已確認練習可先自主測試，正式複習排程仍從今日計畫啟動。
- 尚未完成的一輪在首頁上方接續，選別的類別不會覆蓋。今日複習仍混合到期與每日額度內的新內容；題目快照、有限補考與SRS保留。
- 底部：首頁／進度／設定。進度內容只讀；保留备份、安全還原及作答更正。

## MCP 已存練習狀態

新增preview_practice_status及set_practice_status：向GPT告知學過哪些形式，預覽確認後啟用／暫停已存內容。set帶入預覽expectedContentVersion；題目版本變更拒絕舊確認，owner及完整原JSONB條件避免並行覆寫。保留題目、版本、所有歷史及排程，重送相同狀態不再寫入。不提供任意覆寫既有題目或答案的工具。

GPT可用交接：「請get_study_profile讀完我的進度。我已學過＿＿，想練＿＿。新內容先preview_practice_batch再經我確認add_practice_batch；已存但未啟用的內容先preview_practice_status，我確認後帶入預覽版本呼叫set_practice_status。不要把未學形式設成已學。」

## 實際驗證

- npm test：575 passed／22 skipped（真實環境測試明確opt-in，本輪未執行）。typecheck、lint、production build通過。
- 新選題測試：已學/未學/暫停/封存、概念/能力/題數、到期與錯題優先、單字收件匣及讀音、randomness與輸入不變。MCP測試使用SDK加fake fetch，預覽唯讀、確認與owner、保留metadata、版本、並行拒絕與重送no-op；沒有真實帳戶或雲端寫入。
- 本機production build localhost:3101，Playwright獨立guest、390×844，注入明確本機fixture（て形產出／應用、ない形、未學受身、已暫停使役及文法）。fixture程式限制localhost/guest，未匯入正式帳戶。
- 細選只顯示て/ない；兩個未啟用形式不出題。改範圍再接續仍是原本こんにちは題目，未覆蓋原session。只做到期為0時按鈕停用。選て形產出雙擊開始只有一輪／一題，Enter答食べて、reload接同題、首答1/補考0結算。首頁文法一鍵開始後正確作答結算；三個session為原輪abandoned、て形full completed、文法random completed，無雙擊重複session。
- 實際斷網：首頁點文法範圍→/practice?category=grammar→reload仍為文法，SW v23，資料留存、無橫向溢出。明暗截图已檢視；僅離線favicon/RSC預取有預期網路錯誤。舊/add實際導回首頁、無新增表單。
- 自動化曾在確認放棄尚未完成寫入時立即導航，原session仍在，導致等待新開始按鈕超時；改為等待回首頁後重跑成功。此失敗不算App驗收通過。

## 部署與待真人驗收

不需要新SQL、帳戶或憑證變更。部署來源為本機未提交工作樹，基底SHA不是新UI版本證據。先dry排除.env/DEVLOG/output/巢狀checkout，再stage production、核對並promote；最終ID與公開驗收補記於下方。

尚未驗證：實體手機PWA更新／IME／鍵盤遮擋、GPT Web真實登入後新工具、這輪新版跨裝置完整流程。本機fixture、fake fetch及公開guest都不能代替這些驗收。

### 正式結果（2026-10-08 09:35 Asia/Taipei）

- Production：dpl_8fe8rrseppwjoaKs3NmSney1wG4T。stage 遠端 Next.js build 通過、authenticated Vercel curl 首頁 HTTP 200；promote 成功後，獨立 inspect 正式網址 https://learning-language-three.vercel.app 確認同一 ID、Ready。
- dry：207 entries／201 actual files；排除私人日誌、環境檔、output 與巢狀工作樹，實際私人檔案 0。部署沒有 commit 或 push。
- 正式站 390×844 獨立未登入訪客：六類入口、底部三項、空內容提示、沒有自動範例，形態變化頁保持指定類別。真正離線 reload 形態頁，經首頁導航文法並 reload 仍保持文法；cache 為 learning-language-shell-v23，無橫向溢出。恢復連線後 /add 導回 /，沒有 input 或 textarea。未將本機 fixture 加入正式站。
- MCP 匿名 POST 401、OAuth metadata 200。公開 guest 驗證不代表登入後新 MCP 工具已驗收。
- 正式瀏覽器 console 僅有離線 favicon 與 RSC 預取網路錯誤。另一個自動化探測誤用不存在的「這輪怎麼練？」標題而超時；依當前 snapshot 改用實際類別標題後重跑成功，此超時不當作通過。
- 部署前唯讀記錄為 items 130／attempts 584／schedules 180／sessions 73；比上階段基準已有使用者新作答，不能宣稱 538／71 未變。本輪沒有正式學習資料寫入或 SQL migration。部署後帳戶資料筆數未重新核對：目前 Supabase connector 專案列表不含此專案，CLI 亦未登入，沒有改憑證或以其他專案代替驗收。
- 最終 git diff --check 通過；main 基底 3721d43，110 個變更／未追蹤項目含原有修改，仍為未提交工作樹。

### 2026-10-08 11:33 MCP 真實新增與回傳格式修復

- 重新連線後新版七工具已載入，但 profile 和 practice preview 均回報 `Cannot read properties of undefined (reading '_zod')`，未寫入資料。定位為 SDK 不將 `z.record` 視為 MCP object outputSchema；七工具統一改為 `z.object({}).catchall(z.unknown())`，保留動態輸出欄位。新增真正 Client/McpServer/InMemoryTransport 回歸測試，驗證 tools/list、七工具 tools/call 和缺 confirm 拒絕，無雲端測試寫入。
- 576 passed／22 skipped，typecheck／lint／build／diff check 通過。dry 208 entries／202 actual files／private 0；新 Production dpl_BcGSSF8mkubunJ9Av7D6RBaQXsEA 遠端 build、stage curl 200、promote 和 canonical inspect Ready 通過。未 commit／push，沒有新 SQL 或憑證修改。
- 依使用者已要求填入並在看到相同題目摘要後重試的確認，正式 preview_practice_batch 成功：20 ready、0 duplicates、0 errors，再以 confirm=true add_practice_batch 新增 20 筆。兩頁 get_study_profile 重讀 150 筆，原單字仍 130，所有新增 ID 都存在且 learned/enabled=true，共 156 變體；形態 12、文法 2、助詞 2、句構 1、搭配 2、閱讀 1。尚無新題作答或排程，沒有假造熟練度。第二次只讀 preview 判定 20 duplicates、0 ready，沒有再次寫入。
- 內容檔 output/practice-starter-preview.json 僅候選題目，不含憑證。這次 MCP 真實新增／profile／重複預覽已驗證；手機實際下載後首頁計數、作答、鍵盤與跨裝置仍待真人驗收。

### 2026-10-08 14:14 同步狀態僅設定頁（已部署）
- 移除全站同步列；設定頁保留上傳狀態、待送數、最後下載、錯誤及手動同步，補上本機還原後暫停提示；背景同步未改。
- 本輪 AccountSyncPanel／swAuthCache 共 34 tests passed；typecheck、lint、build、diff check 通過。本輪未重新跑全部測試。
- Production dpl_EjV8xQ3wjVQY8YnAEVUVXYaGVQgh，stage curl 200、遠端 build、promote 與 canonical inspect Ready。dry 211 entries／205 actual files／private 0。
- 正式站公開 guest 390×844：首頁及 /study 沒有全站同步列，設定頁同步區可見、沒有橫向溢出，SW controller /sw.js、cache v25。登入帳戶在作答中同步及實體手機 PWA 未實跑；公開 guest 不是登入狀態驗收。
- 無 SQL、正式資料寫入、commit 或 push；保留既有未提交修改。

### 2026-10-08 15:43 單字「已熟練，跳過這輪」（本機完成，未部署）
- 使用者確認只跳過本輪；移除提示按鈕。跳過同字剩餘能力題／補考，不記作答、不改排程／狀態／每日完成；保留已作答及歷史提示，500ms 防連點避免略過下一字。
- 587 passed／22 skipped；最新相關 10 tests passed；typecheck／lint／build 通過。單元驗證下一輪可再出題、位置過期拒絕、reload、保存失敗回滾；本機 PGlite 執行所有 migrations，驗證 skip/retry、到期日不變、零 attempt、偽造題序拒絕及跨帳戶拒絕。
- Playwright localhost:3108 獨立 guest 390×844 fixture：狗回想／讀音略過後為貓，reload 仍為貓，雙擊只略過狗，最後全略過結算 0 首答／0 正確，沒有提示入口。沒有正式內容、帳戶或作答寫入。
- 必要 migration：supabase/migrations/20261008073457_skip_vocabulary_session.sql。Supabase connector list_projects 沒有此 learning-language 專案，無法套正式 migration；未部署，正式站沒有此按鈕。下一步接通正確 Supabase 專案、套 SQL 後正式同步驗收，再部署；未修改憑證，未 commit／push。實體手機及真實跨裝置未驗證。

### 2026-10-08 Supabase 存取診斷更正
目標為 learning-language-db（yhtxddaiofasliaflqqr），get_project 回報 ACTIVE_HEALTHY，organization_id 為 vercel_icfg_z90iMEFJGdwuO9sUBhNulj4f，屬 Vercel 整合組織。一般 list_projects／list_organizations 僅列 XunC 的一般組織，未列目標，但直接以目標 ID 呼叫 get_project 和 execute_sql 均成功：正式唯讀 items161／attempts670。先前「無法存取」判斷過早；無需修改憑證，之後使用明確專案 ID。CLI 目前未登入，與 MCP 直接存取能力不同。此診斷未套 SQL、未部署。

### 2026-10-08 16:16 單字本輪跳過已部署
- 本機 migration 20261008073457 已套正式 learning-language-db，遠端版本 20261008081256／skip_vocabulary_session；確認 private guard 存在、anon 不可執行、authenticated 可執行。既有 items161／attempts670／schedules180／sessions96 在更新前後相同。
- 正式 SQL transaction 內測試舊／新版 session 跳過、相同事件重送 replayed、沒有作答、排程不變，完成後 rollback；再核對 acceptance session 0，原筆數一致。第一次測試 fixture 使用 JSON 字串代替 text[] 失敗且交易回滾，改為正確 PostgreSQL array 後通過。
- 587 passed／22 skipped、typecheck／lint／build 通過；shell v26。dry 213 entries／207 files／private0；最初篩選誤把目录 entry 當檔案，停止後依 mode 驗證 actual files，沒有私人檔案上傳。
- Production dpl_7BDnnkWCkS6varcvaX3B5YXjbD1Y，遠端 build、stage curl200、promote／canonical inspect Ready。正式站公開 guest390x844：/study 無橫向溢出，載入 bundle 含已熟練按鈕且不含原提示按鈕，SW controller／cache v26。
- 實際按鈕、reload、防雙擊及末題結算已於上一階段本機手機尺寸驗證；此輪公開 guest 無使用者內容，不宣稱登入作答／實體手機／跨裝置已驗收。沒有永久測試帳戶／假作答；未 commit／push，保留原工作樹修改。

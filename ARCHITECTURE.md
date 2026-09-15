# 架構決策（第一階段）

本檔只記錄「為什麼這樣做」的關鍵決策，實作細節看程式碼與其上的註解，不重複 PRODUCT_SPEC.md 的產品需求。

## 分層

```
src/domain/      純函式：型別、SRS 排程、出題規則、統計。不碰 I/O，全部有單元測試。
src/repository/  持久化抽象：LearningRepository 介面 + localStorage／記憶體兩種實作。
src/components/  無狀態、可重用的展示元件。
src/app/         Next.js App Router 頁面，負責串接 domain + repository，管理畫面狀態。
```

頁面只透過 `getRepository()`（`src/repository/index.ts`）拿存取物件，不直接碰
`window.localStorage`。之後要換成雲端資料庫，只需要新增一個實作 `LearningRepository`
介面的 class 並換掉工廠函式回傳的實例，domain 邏輯與頁面元件都不用改。

## 為什麼資料只在 useEffect 裡讀（不是 render 期間直接讀）

`LearningRepository` 目前只有 localStorage 實作，SSR 階段沒有 `window`。如果在 render
期間直接呼叫 `getRepository()` 讀資料，伺服器端渲染出的 HTML 會跟瀏覽器端 hydrate 後的
內容不一致（hydration mismatch）。所以所有頁面都是：先渲染一個 loading 骨架，
掛載後在 `useEffect` 讀一次 repository 再 setState。這是讀取「外部系統」（瀏覽器儲存）
的合法情境，`eslint.config.mjs` 有針對這個情況關掉 `react-hooks/set-state-in-effect`，
理由寫在該檔案的註解裡。

## 版本化資料格式與安全 fallback

`src/repository/schema.ts` 定義 `PersistedStore`（目前 `schemaVersion: 2`）與對應的執行期
型別守衛。讀取 localStorage 內容時：

- JSON 壞掉、`schemaVersion` 是未來版本或完全不明格式 → 整包安全回退成空 store，不猜測轉換；
  JSON 壞掉時也會先把原始內容備份到 `learning-language:store:corrupt-backup`，備份本身失敗
  （例如容量已滿）也不會讓這次啟動白屏。
- `schemaVersion: 1`（舊版）→ 跑 migration（見下方）轉成 v2 形狀，合法資料不會被丟棄。
- `schemaVersion` 正確但個別紀錄格式不對，或日期／數字欄位不合法（例如 `dueAt: "abc"`）
  → 只濾掉那幾筆，其餘資料保留（`sanitizeStore` 是「逐筆過濾」而不是「整包丟棄」）。
- sanitize 後還會做跨紀錄關聯清理：`ScheduleState`／`ReviewAttempt` 必須對應到存在、且語言
  一致的 `LearningItem`，否則整筆丟棄——但 `LearningItem` 本身完全不受影響，只是失去這筆
  排程／作答紀錄，安全回到「沒有排程、可重新當新內容」的狀態，不會整個項目消失。
- 缺少必要陣列（欄位不是陣列）本身就算 fallback 訊號，不會被靜默當成合法空陣列。

之後若要再升版（例如 schemaVersion 3），在 `schema.ts` 依樣加上新的型別守衛與
`schemaVersion 2 → 3` 的 migration 函式即可，呼叫端（repository 的 constructor）完全不用改。

### schemaVersion 1 → 2（2026-09-15 repair batch）

升版原因是 R1（多能力 mastery）與 R3（session 中途重整恢復）都需要改資料形狀，順便把
R2 的日期／數字驗證一起做嚴謹：

- `ScheduleState` 從「一個 LearningItem 一筆」改成「一個 (learningItemId, ability) 一筆」。
  migration 把 v1 的單一進度視為該項目 **recall** 能力的既有進度，reading 能力從零開始
  （之後會被排進「新內容」補齊，不會補一個假造的、其實沒真的練過的 reading 歷史）。
- `StudySession` 新增 `status`（`in_progress` / `completed` / `abandoned`）與 `plannedUnits`。
  v1 的 session 只在完成時才會被存下來，所以 migration 一律標成 `completed`，
  `plannedUnits` 從既有 `exerciseResults` 反推（順序、ability、new/review 分類都還原得出來）。
- `LearningItem`／`ReviewAttempt` 形狀不變，直接沿用同一套（更嚴格的）型別守衛。
- migration 本身**不算** fallback（不會觸發 corrupt-backup 或 console 警告）——乾淨的 v1
  資料升版是預期行為；只有 migration 過程中真的濾掉壞紀錄，才會標記 fallback。
- 測試見 `src/repository/schema.test.ts`「R2：v1 → v2 migration」。

## R1：多能力（recall／reading）mastery

一個日文單字可能需要練兩種能力：**recall**（中文 → 日文）與 **reading**（漢字 → 假名）。
`src/domain/abilities.ts` 的 `requiredAbilities()` 決定一個項目需要哪些能力（純假名項目
只需要 recall；讀音跟答案不同才需要 reading）。

- 每個 (item, ability) 組合各自有獨立的 `ScheduleState`（見上面 schemaVersion 2），
  各自的 streak／lapseCount／到期日完全不互相影響（`src/domain/srs.ts` 的
  `computeNextSchedule` 不變，只是現在對每個能力分別呼叫）。
- 一個項目的整體 `ItemStatus` 由 `combineAbilityStatuses()`（`src/domain/srs.ts`）把
  「必要能力」各自的狀態合併：全部 mastered 才是 mastered、任何一項 struggling 就整體
  struggling，避免「只考 recall 就 mastered」。
- 今日佇列（`src/domain/queue.ts` 的 `buildTodayQueue`）的最小單位是「一個 (item, ability)」，
  不是「一個 item」。題型不再依佇列索引奇偶決定（那樣排序固定或只有一個字時會永遠只出
  同一種題型），而是依每個能力**各自的排程歷史**：
  - 完全沒碰過的項目：今天只把 **recall** 當新內容引入（避免一次塞兩題新內容），
    reading 留到 recall 有紀錄之後才有資格被排進新內容補齊。
  - 已經有 recall 排程、但 reading 還沒開始的項目：reading 優先於全新項目被排進新內容，
    避免已經投入的項目長期卡在只學一半。
  - 兩種能力各自到期各自出現在複習佇列，互不影響彼此的間隔。

## R3：StudySession 中途重整恢復

`StudySession` 現在有 `status` 與 `plannedUnits`（session 建立當下就固定的題目順序）。
`src/repository/baseRepository.ts` 的 `getOrCreateInProgressSession()`／
`recordGradedAttempt()`／`abandonSession()`：

- 建立 session 的當下就立即持久化為 `in_progress`（不是只存在 React state，也不是等到
  最後一題才第一次寫入）。
- 每答完一題，`recordGradedAttempt()` 把這題的結果 append 進同一個 session 的
  `exerciseResults`；`exerciseResults.length` 就是「已完成幾題」，同時也是重新整理後
  應該恢復到 `plannedUnits` 的哪個索引。
- 最後一題完成時，同一次寫入（不是額外一次）把 session 標成 `completed` 並設定
  `completedAt`——不會出現「最後一題已存、session 卻還沒標完成」的中間狀態。
- 同一語言同時只會有一個 `in_progress` session：`getOrCreateInProgressSession()` 找到
  既有的就直接回傳（忽略這次傳入的候選 plannedUnits），沒有才建立新的。
- `/study` 頁掛載時一律先呼叫 `repository.getInProgressSession('ja')`，有就依
  `exerciseResults.length` 恢復到對的題目，完全不依賴 React state 存活；重新整理／
  換分頁都能恢復。
- 「放棄本次學習」（`abandonSession`）只是把 session 標成 `abandoned`，**不會**刪除已經
  產生的 `ReviewAttempt` 或 `ScheduleState`——已經發生的學習事實不會因為放棄剩下的題目
  而消失。`listStudySessions()` 預設只回傳 `completed`，`abandoned`／`in_progress` 不會
  冒充完整的學習歷史（進度頁、首頁的「最近學習紀錄」都用預設值）。
- 邊界情況：如果恢復時發現 `plannedUnits` 裡尚未作答的某個項目已經不存在了（例如中途在
  `/add` 清除了這個 session 引用的範例資料），視為資料不一致，放棄這個 session（保留已有
  的作答與排程）並建立新的，不會讓頁面卡住或崩潰。

## R4：持久化失敗必須誠實，且是原子寫入

`BaseLearningRepository`（`src/repository/baseRepository.ts`）採用 copy-on-write：每次變更
先複製一份完整 store、在複製品上修改，呼叫 `persistSnapshot(next)`；只有沒有丟例外，
`this.store` 才會真的換成新版本。

- `LocalStorageLearningRepository.persistSnapshot()` 寫入失敗（容量爆掉、序列化失敗等）
  會丟出型別化的 `PersistenceFailedError`（`src/repository/errors.ts`），**不會**被吞掉、
  也不會只印 console。呼叫端保證這種情況下記憶體狀態完全不變，不會出現「schedule 更新
  成功、但 attempt 沒存到」的半套資料。
- 「評分（算下一個排程）＋更新 item 整體狀態＋新增 ReviewAttempt＋更新 session」收斂成
  `recordGradedAttempt()` 一次呼叫、一次 commit，是名符其實的單一交易，不是分好幾次
  各自 try/catch。
- 呼叫端（`/add`、`/study` 頁）一律 try/catch：失敗就顯示清楚的中文錯誤訊息、**不**顯示
  「已新增」、**不**清空表單、**不**前進到下一題或結算，讓使用者可以直接重試同一個操作。
  因為失敗代表「這次完全沒有寫入任何東西」，用同樣的 exerciseId／內容重試不會產生
  duplicate（`recordGradedAttempt` 另外用 `(sessionId, exerciseId)` 擋重複送出）。
- `/study` 的評分按鈕有 `isSubmittingRef` 防重複觸發；一次評分的複雜運算全部在
  `recordGradedAttempt` 內部單一同步呼叫完成，不存在「兩次點擊各自進行到一半」的競態。
- `getRepository()` 在 localStorage 完全不可用時退回 `MemoryLearningRepository`
  （`durability: "volatile"`）；`DurabilityBanner`（`src/components/DurabilityBanner.tsx`，
  掛在 `layout.tsx`）會在畫面上明確警告「重新整理會遺失資料」，不是只寫 console。

## 第三輪精準修復（2026-09-15）

沿用既有架構與 schemaVersion 2，不新增資料版本，只收斂既有規則的漏洞。

### 精準修復 1：recordGradedAttempt 綁定 session 下一個 planned unit

舊版只用 `session.status === "in_progress"` 擋掉已完成的 session，但呼叫端傳入的
`learningItemId`／`ability`／`exerciseType` 完全沒有跟 session 自己記錄的題目順序核對——
UI 保證答對順序，repository 卻沒有獨立驗證，等於把正確性完全交給呼叫端。

`baseRepository.ts` 的 `recordGradedAttempt` 現在會先用 `session.exerciseResults.length`
算出「下一個 expected planned unit」，逐項核對：

1. 還有沒有下一題（`plannedUnits[expectedIndex]` 存在）。
2. `input.learningItemId` 是否等於 expected unit 的 `learningItemId`。
3. `input.ability` 是否等於 expected unit 的 `ability`。
4. `input.exerciseType` 是否等於 `input.ability`（recall→recall、reading→reading）。

任何一項不符就丟一般 `Error`（跟「session 不存在」同一類：呼叫端邏輯錯誤，不是使用者可
重試的持久化失敗），而且這些檢查全部在 `this.cloneStore()` 之後、`this.commit(next)` 之前，
所以驗證失敗時連 clone 出來的 `next` 都不會被拿去 commit——不會產生 attempt、不會更新
schedule／item status／session，也不會寫入 localStorage（沿用既有的 copy-on-write：
沒呼叫 `commit` 就等於沒發生任何事）。既有的 `(sessionId, exerciseId)` 防重複送出檢查保留，
用來擋「同一題被重複送出」這種跟 unit 綁定無關的另一種失誤。

### 精準修復 2：StudySession 的內部一致性與跨紀錄關聯

`schema.ts` 的 `isStudySession` 除了原本的欄位形狀，現在還驗證：

- `exerciseResults.length` 不能超過 `plannedUnits.length`。
- 每筆 `exerciseResults[i]` 必須對應同一位置 `plannedUnits[i]` 的 `learningItemId`，
  且 `exerciseType` 必須等於該位置的 `ability`。
- `in_progress`／`abandoned`：不能有 `completedAt`，且必須「還有下一題」
  （`exerciseResults.length < plannedUnits.length`）——`abandoned` 是從 `in_progress`
  凍結來的，凍結那一刻依定義必然還沒把題目全部做完，跟 `in_progress` 用同一條規則。
- `completed`：必須有 `completedAt`，且題目必須全部做完（不能還有下一題）。

這些是「session 自己內部要自洽」的規則，不需要知道其他 LearningItem 是否存在，所以留在
`isStudySession` 裡。另外新增一條跨紀錄規則在 `finalizeStore`：**`in_progress` 的
`plannedUnits` 必須全部引用存在、且語言一致的 LearningItem**，違反就整個 session 丟棄
（不是修復，因為一個引用不到項目的 in_progress session 沒辦法被 `/study` 正常恢復，
留著只會卡住畫面）。`completed`／`abandoned` 的歷史紀錄不受此限——本來就可能引用之後被
使用者刪除的項目，只要內部 planned/result 對位仍合法就保留。

這條規則的副作用（預期內、非 bug）：如果使用者在有 in_progress session 時清掉了那個
session 引用的項目，**下一次真正重新整理**（重新解析 localStorage）就會在 sanitize 階段
直接丟棄那個壞掉的 session，`/study` 會自然當成「沒有進行中的 session」。這跟精準修復 3
的「同一個分頁、還沒重新整理」情境是兩條互補的防線，不是重複——同分頁內用同一個
repository 實例時，`this.store` 不會重新跑 sanitize，所以需要頁面自己偵測資料缺口。

### 精準修復 3：/study 不得吞掉 abandonSession 的失敗

舊版在偵測到資料缺口（in_progress session 引用的項目消失）時呼叫 `abandonSession`，
用空的 `catch {}` 吞掉例外，直接往下繼續建立新 session——等於假裝放棄成功。如果放棄
本身因為持久化寫入失敗而沒有成功，這個壞掉的 session 其實還卡在 `in_progress`，
卻同時又建出第二個 `in_progress` session，違反「同語言同時只有一個 in_progress」的前提。

修法是把整個初始化決策抽成 `src/app/study/sessionInit.ts` 的 `initializeStudySession()`
純函式（吃 `LearningRepository` + `Date`，不碰 React），回傳
`{ phase: "empty" | "active" | "error", ... }` 的判別聯集：

- `abandonSession` 失敗 → 直接回傳 `{ phase: "error" }`，**不會**接著呼叫
  `getOrCreateInProgressSession`，也不會把那個壞掉的 session 標成 active。已經產生的
  attempt／schedule 完全不受影響（`abandonSession` 失敗代表連「標成 abandoned」這個變更
  本身都沒寫入，session 在儲存媒介裡原封不動還是 in_progress）。
- 因為抽成純函式、且吃的是 `LearningRepository` 介面，可以直接拿真正的
  `LocalStorageLearningRepository` 配合 `test/localStorageMock.ts` 的可控失敗開關寫單元
  測試（`sessionInit.test.ts`），不必架設 jsdom／React Testing Library 就能自動驗證這個
  分支，不是只能在瀏覽器裡人工點一次。
- 页面元件（`study/page.tsx`）的 `useEffect` 現在只做「呼叫 `initializeStudySession`
  →把回傳結果映射成畫面 state」，決策邏輯不再直接寫在 React effect 裡。

### 精準修復 4：日期驗證要看真實日曆，不能只看格式

`schema.ts` 的 `isIsoDateString` 原本只用 regex 檢查格式、加上 `Number.isNaN(date.getTime())`
排除完全解析失敗的字串。問題是 `new Date("2026-02-31T00:00:00.000Z")` 這種「格式合法、
日期不存在」的字串，在這個專案實際執行的 JS 引擎裡不會回傳 `Invalid Date`，而是被靜默
正規化成 3 月的某一天——單靠格式 regex 加 NaN 檢查會誤判為合法。

修法是把 regex 改成有 capture group，解析出年／月／日／時／分／秒／毫秒，用 `new Date()`
解析後再把 UTC 的年月日時分秒毫秒讀回來，跟輸入逐項比對；只要有一項跟輸入不一致，
就代表原始輸入其實是不存在的日期（2 月 31 日、2 月 30 日、非閏年的 2 月 29 日），必須
拒絕。合法的閏年 2 月 29 日（例如 2024、2028 年）不受影響，仍然通過。既有的 1～3 位小數
毫秒相容性（`toISOString()` 固定 3 位，但保留對 1～2 位的相容）維持不變。

## SRS／出題規則寫在哪裡

- 到期日規則：`src/domain/srs.ts`（`computeNextSchedule`、`deriveStatus`、
  `combineAbilityStatuses`），規則本身的文字說明就寫在檔案開頭的註解與 PRODUCT_SPEC.md
  第 7 節，單元測試在 `srs.test.ts`。
- 一個項目需要哪些能力：`src/domain/abilities.ts`。
- 今日佇列（到期複習優先於新內容、新內容每日安全上限 50、單位是 (item, ability)）：
  `src/domain/queue.ts`。
- 出題規則（中文→日文 recall／漢字→假名 reading，依每個能力各自的排程歷史決定，
  不依賴佇列位置，也不是 AI 出題）：`src/domain/exercises.ts`。

全部是純函式、不依賴模型或亂數，同樣輸入永遠得到同樣輸出。

## 已知簡化（誠實標示，非隱藏限制）

- 每題只對應一個 LearningItem；`Exercise.learningItemIds` 保留陣列是為了未來句子題
  可以關聯多個項目，本階段不使用這個能力。
- 使用者輸入的「自己作答」文字（study 頁的輸入框）不會被自動比對批改，只是幫助主動
  回想；正確與否由使用者自評（答對／部分答對／答錯）。這是刻意的設計，不是 bug。
- PWA icon 是暫時的純色 SVG 佔位圖示，不是最終品牌視覺；service worker
  （`public/sw.js`）只做最基本的 app shell 快取，沒有背景同步或推播。
- 英文（`language: "en"`）與文法／片語／搭配（`type`）欄位已經存在於型別與 repository，
  但沒有任何頁面 UI 使用，避免之後擴充需要改資料邊界。
- 只支援單分頁使用：沒有處理兩個分頁同時開著 `/study` 各自寫入的情境；`in_progress`
  session 的「同時只有一個」是靠單分頁的同步 JS 執行順序保證，不是跨分頁鎖。
- `recordGradedAttempt`／`getOrCreateInProgressSession` 內部找不到對應資料時（例如
  session 或 item id 不存在）會丟出一般 `Error`（不是 `PersistenceFailedError`），代表
  呼叫端邏輯本身有誤，正常操作流程不該觸發；這跟「使用者可重試的持久化失敗」是刻意
  分開的兩種錯誤類別。

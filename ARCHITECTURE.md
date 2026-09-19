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

## R5：規則式自動評分＋漢字／平假名雙模式（2026-09-15）

沿用既有架構與 schemaVersion 2（不需要升版：新增的資料完全用既有的
`AttemptResult`／`StudySessionExerciseResult`／`ReviewAttempt` 形狀，只是把「誰來判斷
對不對」從使用者自評改成規則式函式，沒有新增欄位）。取代 study 頁原本「使用者自己
輸入只是幫助回想、正確與否由使用者自評（答對／部分答對／答錯）」的設計——這個舊決策
現在已經不成立，因為作答是規則式自動判定，不再需要（也不再提供）自評。

### 自動判定：`src/domain/text.ts` + `src/domain/grading.ts`

比對邏輯拆成兩層，都是純函式、不碰 React、不串 AI／外部 API：

- `text.ts`：`containsKanji`（判斷答案是否含漢字，供 UI 標籤使用）、
  `katakanaToHiragana`（片假名逐字轉平假名，非片假名字元原樣保留）、
  `normalizeForComparison`（Unicode NFKC + 移除所有空白字元）。這個 App 的答案都是
  單一日文詞彙，詞彙內不該有空白，所以「合理處理多餘空格」直接定義成整段清除，
  同時涵蓋 trim 與詞中間誤觸的空白。
- `grading.ts` 的 `gradeAttempt({ ability, rawInput, expectedAnswer })`：
  - `recall`：雙方都跑 `normalizeForComparison` 後完整比對（不是子字串比對）。
  - `reading`：額外把雙方都跑 `katakanaToHiragana`，讓片假名輸入可以判定為讀音正確；
    羅馬字（例如 "sensei"）不會被轉換成假名，正規化後永遠不等於期望的假名答案，
    自然被拒絕，不需要額外的黑名單邏輯。
  - 空白（含只有空白）輸入正規化後是空字串，`correct` 永遠是 `false`——這是比 UI
    disable 送出按鈕更底層的一道防線。
  - 回傳 `{ correct, normalizedInput, expectedAnswer }`；`normalizedInput` 是比對用的
    正規化結果（reading 已經是轉換後的平假名），給 UI 顯示「你的答案」。

### 漢字／單字練習（recall）與平假名練習（reading）UI 標籤：`src/lib/labels.ts`

`abilityDisplayLabel(ability, item)` 集中決定使用者看到的名稱，不出現 recall／reading
英文內部代稱：`reading` 固定顯示「平假名練習」；`recall` 依 `item.answer` 是否含漢字
（`containsKanji`）分別顯示「漢字練習」或「單字練習」——同一種 recall 能力，純假名項目
沒有漢字可以練，顯示「漢字練習」會誤導使用者。哪個項目需要 reading 能力（有獨立且有
價值的讀音、不是「answer 與 reading 相同的純假名詞」）維持既有的 `abilities.ts`
`hasUsableReading`／`requiredAbilities` 判斷，這次沒有改動判斷邏輯本身。

### 作答 UX：`src/app/study/page.tsx` 從「自評」改成「自動評分＋下一題」

單題流程從「輸入（不批改）→ 顯示提示／答案 → 使用者自己按答對／部分答對／答錯」，
改成兩個子階段（`subPhase`）：

- `answering`：輸入框（Enter 或「確認答案」送出，空白時送出按鈕 disabled，
  `<form onSubmit>` 讓手機虛擬鍵盤的「前往」動作也能正確送出）＋可選的限一次提示。
  送出時呼叫 `gradeAttempt` 算出結果，立即呼叫 `recordGradedAttempt`
  （`result: graded.correct ? "correct" : "incorrect"`，`usedHint` 照舊傳目前的提示
  使用狀態，所以「提示後答對」會如實記錄 `usedHint: true`，不會因為改成自動評分而遺失）；
  寫入失敗（R4）就停在 `answering`、顯示錯誤、不切到 `graded`，使用者可以直接重送。
- `graded`：顯示「答對了」，或「答錯了」＋你的答案／正確答案；「下一題」（最後一題顯示
  「查看結果」）用 `autoFocus` 讓 Enter 鍵原生觸發按鈕點擊，不用額外攔截 keydown；
  `advancingRef` 在按下當下立刻鎖住、在下一題的重置 effect 才解鎖，防止 Enter 鍵重複
  （例如按住不放的 key repeat）在同一題內把 `currentIndex` 推進兩次。

這兩個子階段只存在於 React state，重新整理會遺失（回到 `answering`），但底層的作答紀錄
在送出當下就已經原子寫入（見 R4），所以重新整理只是「少看一次已經批改完的回饋」，
不會重複提交、也不會遺失作答資料——跟 R3 既有的「用 `exerciseResults.length` 當恢復
索引」機制完全相容，這次沒有改動那個機制。

### 「我其實答對了」修正：`markAttemptCorrect`（新的 repository 原子 API）

自動判定不可能 100% 涵蓋所有合理變體（例如使用者用了系統沒預期的同義寫法），所以在
`graded` 子階段、被判定 incorrect 時提供一個小的修正按鈕，只在「下一題」之前可用
（一旦呼叫 `handleNext` 換題，這一題的修正入口就從畫面上消失）。

`BaseLearningRepository.markAttemptCorrect({ sessionId, exerciseId })`（`baseRepository.ts`）：

- 用 `session.exerciseResults` 的最後一筆是否等於傳入的 `exerciseId` 當「僅能在下一題前
  使用」的硬性檢查——不看 `session.status`，因為最後一題評分的同一次寫入就會把 session
  標成 `completed`（見 R3），但那一題的修正窗口在使用者體感上依然「還沒到下一題」，
  必須放行。
- 不新增第二筆 `ReviewAttempt`：直接原地把既有那筆的 `result` 改成 `"correct"`（其餘
  欄位，包含 `usedHint`／`reviewedAt`，原樣保留），`StudySessionExerciseResult` 同步更新。
- 排程不是在「已經套用 incorrect」的排程上再疊加修正，而是把這個 `(learningItemId,
  ability)` 在這筆之前的作答（依 `reviewAttempts`的寫入順序，也就是時間順序，可能橫跨
  多個 session——SRS 本來就是跨 session 累積）重新跑一遍 `computeNextSchedule`，重建出
  「這筆發生前」的 streak／lapseCount，再用 `"correct"` 而不是原本的結果算一次。這樣
  修正後的排程跟「這一題當初就直接答對」完全一致，不會因為曾經被誤判成 incorrect 而
  留下任何痕跡（例如多餘的 lapseCount）。
- `itemStatus` 用跟 `recordGradedAttempt` 一致的方式，把這個項目「必要能力」各自的狀態
  （剛修正的這項用新算出的 `computed.status`，另一項讀既有 `ScheduleState`）合併。
- 全部在同一次 `cloneStore → mutate → commit` 內完成，是名符其實的單一交易；寫入失敗會
  丟 `PersistenceFailedError`，`attempt`／`schedule`／`session` 三者保證不變（跟 R4
  的 copy-on-write 保證相同）。
- 不需要新的 schema 欄位：`AttemptResult` 本來就包含 `"correct"`，這次只是換一個
  呼叫入口去設定既有欄位，schemaVersion 維持 2。

### 結算與進度：分別看到漢字練習與平假名練習

- `src/domain/stats.ts` 新增 `summarizeSessionResultsByAbility`（把一次 session 的
  `exerciseResults` 依 `exerciseType` 拆成 recall／reading 分別的 total／correct／
  正確率，給 `/study` 結算頁用）與 `computeAbilityStatusCounts`（依 `requiredAbilities`
  把 items＋scheduleStates 拆成 recall／reading 分別的 `StatusCounts`，只有真的需要
  該能力的項目才計入，給 `/progress` 頁用；純假名項目因為不需要 reading，不會出現在
  reading 的統計裡）。兩個都是純函式，輸入輸出固定。
- 結算頁原本的「答對／部分／答錯」三欄簡化成「答對／答錯」二欄——自動評分只會產生
  `correct`／`incorrect`，`partial` 不再由新流程產生（型別與 schema 仍保留 `partial`，
  只是不再是這條路徑的輸出，歷史資料裡如果有 `partial` 不會造成 crash，只是不會被算進
  這兩欄，等同「這題不計入答對也不計入答錯」的誠實呈現，不會誤報成某一邊）。
- 進度頁新增「分項能力狀態」區塊，漢字練習／平假名練習各自顯示已接觸／學習中／已掌握／
  需要加強四個數字，讓使用者看得出兩種能力各自的狀態，不是只有合併後的單一整體狀態。

### 順手修正：`getOrCreateInProgressSession` 的輸入驗證

舊版完全不驗證傳入的 `plannedUnits`：如果呼叫端傳空陣列，會建立出一個
`plannedUnits: []`、`exerciseResults: []` 的 `in_progress` session；這種形狀在**這次
分頁存活期間**可以正常運作（`this.store` 是記憶體物件，沒有重新跑過 schema 驗證），
但 `schema.ts` 的 `isStudySession` 其實要求 `in_progress` 必須「還有下一題」
（`exerciseResults.length < plannedUnits.length`），`plannedUnits: []` 必然不成立；
同樣地，如果 `plannedUnits` 引用不存在或語言不一致的項目，`finalizeStore` 的跨紀錄
清理會在下一次真正重新解析 localStorage 時把整個 session 丟棄。兩種情況都是「這次
還能用、重新整理後突然消失」的不一致，而且是 repository 自己一手造成的（呼叫端如果
剛好符合這個邊界情況，repository 明明可以在寫入當下就擋下來，卻放任寫出一包自己的
schema 會丟棄的資料）。

修法：`getOrCreateInProgressSession` 在「真的要建立新 session」的分支（已經有
`in_progress` session 可以恢復時不受影響，因為這時傳入的 `plannedUnits` 根本不會被
使用）新增兩項驗證，不符合就丟一般 `Error`（呼叫端邏輯錯誤，比照 `recordGradedAttempt`
既有的驗證風格）：`plannedUnits` 不能是空陣列；每個 unit 的 `learningItemId` 必須對應
到存在、且語言與這次 session 一致的 `LearningItem`。正常的 `/study` 初始化流程
（`sessionInit.ts` 的 `buildFreshSession`）本來就會在 `queueResult.units.length === 0`
時提早回傳 `empty`、且佇列裡的每個 unit 都是直接從剛查到的 items 建構出來，不可能觸發
這兩種情況，所以這次修正對既有頁面行為沒有影響，純粹是把「repository 自己的資料完整性
承諾」補齊，防禦未來新的呼叫端不小心違反。

## SRS／出題規則寫在哪裡

- 到期日規則：`src/domain/srs.ts`（`computeNextSchedule`、`deriveStatus`、
  `combineAbilityStatuses`），規則本身的文字說明就寫在檔案開頭的註解與 PRODUCT_SPEC.md
  第 7 節，單元測試在 `srs.test.ts`。
- 一個項目需要哪些能力：`src/domain/abilities.ts`。
- 今日佇列（到期複習優先於新內容、新內容每日安全上限 50、單位是 (item, ability)）：
  `src/domain/queue.ts`。
- 出題規則（中文→日文 recall／漢字→假名 reading，依每個能力各自的排程歷史決定，
  不依賴佇列位置，也不是 AI 出題）：`src/domain/exercises.ts`。
- 作答自動判定規則式：`src/domain/grading.ts`（`gradeAttempt`）＋
  `src/domain/text.ts`（NFKC 正規化、片假名轉平假名、漢字偵測），見上方「R5」。

全部是純函式、不依賴模型或亂數，同樣輸入永遠得到同樣輸出。

## 已知簡化（誠實標示，非隱藏限制）

- 每題只對應一個 LearningItem；`Exercise.learningItemIds` 保留陣列是為了未來句子題
  可以關聯多個項目，本階段不使用這個能力。
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

---

# 雲端化架構（2026-09-16）：Supabase 同步、Auth、MCP

本節是**凍結的合約**，供三條並行工作分工依循：DB／安全（A）、App repository／sync／
auth／migration（B）、MCP（C）。三者對彼此的介面（資料表、欄位、RPC 簽名、outbox
操作型別、檔案路徑）都以本節為準；實作中如發現本節有具體錯誤或遺漏，依本節的整體
意圖判斷並在交付報告中明確記錄偏離之處，不要靜默改變合約形狀。

## 核心決策：Local-first + outbox，不是「雲端優先、本機當快取」

**`LearningRepository` 介面、`BaseLearningRepository`、`LocalStorageLearningRepository`、
`MemoryLearningRepository` 完全不變（0 個方法簽名變動）。** 這是刻意的架構選擇，不是
偷懶：

- 這三個檔案＋整個 `src/domain/`（SRS、佇列、出題、評分、統計）已經有 193 個通過的
  測試，且是同步、零 I/O-per-question 的設計——`this.store` 是完整的記憶體快照，
  `listItems`／`buildTodayQueue` 等讀取完全不碰網路。**這正好就是「進入 10 題 session
  後切題不應每題重新下載」的要求**，不需要新機制，只需要不要破壞它。
- 把整個介面改成 async（回傳 `Promise`）會牽動所有頁面元件與 193 個測試，卻換不到
  任何實質好處——真正需要的只是「額外把已經發生的本機變更，背景推到 Supabase」。
- 因此雲端能力用**組合（composition）**疊加，不是修改或子類化上述四個檔案：新增
  `SyncingLearningRepository`（見下）包一層 `LocalStorageLearningRepository`，本機讀寫
  完全走原本的同步路徑不變，額外做的事只有「寫入成功後，把這次做了什麼記進 outbox，
  非阻塞地觸發背景同步」。

## 資料流總覽

```
使用者操作
  → SyncingLearningRepository.recordGradedAttempt(...)
      1. inner.recordGradedAttempt(...)   ← 原本的 LocalStorageLearningRepository，完全不變，
                                             失敗就整個拋出，不寫 outbox（沒發生的事不用同步）
      2. 成功 → 組一筆 outbox entry（型別見下）→ outbox.enqueue(entry)（同步、localStorage）
      3. syncEngine.kick()                 ← 非阻塞（不 await），背景嘗試 drain outbox
  ← 立即回傳（跟現在完全一樣的使用者體感速度，UI 不等網路）

SyncEngine（背景）
  - drain: 依序取 outbox 最舊的一筆 → 呼叫對應的 Supabase 操作（見下「outbox 操作
    對應表」）→ 成功就從 outbox 移除、繼續下一筆；失敗（網路／5xx）就停止 drain、
    留在 outbox、之後（下次 kick、下次啟動、或指數退避計時器）重試；認證失效
    （401）就標記需要重新登入、停止 drain。
  - pull-merge（登入時／app 啟動時已登入）：抓遠端目前使用者的所有列，merge 進本機
    store：遠端有、本機沒有的 id → 加入本機；本機有、遠端也有、且這筆目前沒有待送
    outbox entry → 用遠端覆蓋本機（此時遠端理應更新，因為沒有本機在飛的變更）；
    本機有待送 outbox entry → 保留本機（避免蓋掉還沒送出的變更）。這是刻意簡化的
    「單一主要裝置＋離線間隙」模型，不是完整多裝置即時合併；已知限制見下方
    「已知簡化」。
```

## 檔案 ownership（避免三邊互相覆寫）

| 範圍 | 擁有者 | 路徑 |
|---|---|---|
| DB schema／RLS／RPC／Supabase client 工廠／型別 | A | `supabase/**`、`src/lib/supabase/**` |
| Outbox／SyncEngine／migration／auth 頁面／偏好設定／同步狀態 UI | B | `src/repository/sync/**`、`src/repository/index.ts`（修改）、`src/app/auth/**`、`src/components/SyncStatusBanner.tsx`、`src/components/MigrationPanel.tsx`、`src/app/settings/page.tsx`（修改）、偏好設定相關 `src/lib/preferences/**` |
| MCP server／OAuth consent UI／MCP 專用文件 | C | `src/app/mcp/**`、`src/app/oauth/**`、`src/app/api/oauth/**`、`src/app/.well-known/**`、`src/lib/mcp/**`、`scripts/register-mcp-oauth-client.mjs` |
| 已由本輪先完成，三邊都可直接使用，不要重複修改 | 協調者（已完成） | `src/domain/romaji.ts`、`domain/types.ts` 的 `romaji`/`partOfSpeech`/`exampleSentence`、`domain/stats.ts` 的 `computeAccuracyOverWindow`/`computeHintRateOverWindow` |

不要修改不屬於自己那一列的檔案；若發現必須修改共用檔案（例如 `domain/types.ts`
需要再加欄位），在交付報告中明確提出，由整合階段處理，不要三邊各自改同一個共用檔案。

## 環境變數（已存在於 gitignored `.env.local`，不得印出實際值）

瀏覽器可用（`NEXT_PUBLIC_` 前綴）：`NEXT_PUBLIC_SUPABASE_URL`、
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（優先於舊式 `NEXT_PUBLIC_SUPABASE_ANON_KEY`，
兩者現況都存在，新程式一律用 publishable key）。

僅伺服器可用（Route Handler／Server Component／腳本，絕對不能進到任何 client
component 或瀏覽器 bundle）：`SUPABASE_URL`、`SUPABASE_SECRET_KEY`（新式，優先使用）、
`SUPABASE_SERVICE_ROLE_KEY`（舊式，兩者現況都存在）、`SUPABASE_JWT_SECRET`（本輪不需要
直接使用，OAuth 驗證走 `supabase.auth.getUser(token)`，不必自己 verify JWT）、
`POSTGRES_URL_NON_POOLING`（migration／DDL 用直連，不要用連 pgbouncer 的
`POSTGRES_URL` 跑 migration）。

## 資料表（schema `public`，全部 `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`）

所有表都有 `user_id uuid not null references auth.users(id) on delete cascade`
（直接存欄位，不用 join，RLS 判斷成本最低，跟現有本機模型在每個子紀錄冗餘存
`language` 是同一種設計理由）。id 一律用 `text primary key`（沿用
`src/domain/id.ts` 的 `generateId()` 格式，例如 `item_<uuid>`，不是原生
Postgres `uuid` 型別）。

### `learning_items`
```
id                text primary key
user_id           uuid not null references auth.users(id) on delete cascade
language          text not null check (language in ('ja','en'))
type              text not null check (type in ('vocabulary','grammar','phrase','collocation'))
prompt_zh         text not null
answer            text not null
reading           text
explanation       text
romaji            text
part_of_speech    text
example_sentence  text
source            text not null check (source in ('ai','textbook','teacher','song','manual'))
tags              text[] not null default '{}'
status            text not null check (status in ('new','learning','mastered','struggling'))
created_at        timestamptz not null
is_seed           boolean not null default false
content_key       text generated always as (
                    language || '|' || type || '|' || prompt_zh || '|' || answer || '|' || coalesce(reading, '')
                  ) stored
updated_at        timestamptz not null default now()

unique (user_id, content_key)   -- 跟本機 addItemsIfMissing 同一套內容去重鍵，見 baseRepository.ts 的 contentKey()
index (user_id, language)
```

### `schedule_states`
```
user_id           uuid not null references auth.users(id) on delete cascade
learning_item_id  text not null references learning_items(id) on delete cascade
ability           text not null check (ability in ('recall','reading'))
language          text not null check (language in ('ja','en'))
due_at            timestamptz not null
interval_days     integer not null check (interval_days > 0)
streak            integer not null check (streak >= 0)
lapse_count       integer not null check (lapse_count >= 0)
last_reviewed_at  timestamptz
updated_at        timestamptz not null default now()

primary key (learning_item_id, ability)
index (user_id, due_at)
```

### `study_sessions`
```
id               text primary key
user_id          uuid not null references auth.users(id) on delete cascade
language         text not null check (language in ('ja','en'))
status           text not null check (status in ('in_progress','completed','abandoned'))
started_at       timestamptz not null
completed_at     timestamptz
planned_units    jsonb not null   -- [{learningItemId, ability, kind}], 跟本機 StudySessionPlannedUnit[] 同形狀
new_item_ids     text[] not null default '{}'
review_item_ids  text[] not null default '{}'
updated_at       timestamptz not null default now()
```
不儲存 `exercise_results`——正規化拆進 `review_attempts`，見下方欄位 `sequence_in_session`；
需要重建時用 `select ... from review_attempts where session_id=? order by sequence_in_session`。

### `review_attempts`
```
id                    text primary key
user_id               uuid not null references auth.users(id) on delete cascade
session_id            text not null references study_sessions(id) on delete cascade
sequence_in_session   integer not null   -- 0-based，對應 study_sessions.planned_units 的位置
seq                   bigint generated always as identity   -- 全域插入順序，見下方 mark_attempt_correct 的用途
exercise_id           text not null
learning_item_id      text not null references learning_items(id) on delete cascade
language              text not null check (language in ('ja','en'))
exercise_type         text not null check (exercise_type in ('recall','reading','spelling','translation'))
result                text not null check (result in ('correct','partial','incorrect'))
used_hint             boolean not null
response_time_ms      integer not null check (response_time_ms >= 0)
reviewed_at           timestamptz not null

unique (session_id, exercise_id)       -- 冪等：同一題在同一 session 只能記一次
unique (session_id, sequence_in_session)
index (user_id, learning_item_id, exercise_type, seq)   -- markAttemptCorrect 的「是否有更新的作答」查詢
index (user_id, reviewed_at)                             -- get_learning_context 的時間視窗查詢
```

`seq` 是 `mark_attempt_correct` 判斷「這個 (learning_item_id, exercise_type) 之後有沒有
更新的作答」的依據，對應本機 `baseRepository.ts` 用**陣列插入順序**（不是時間戳記）
判斷 `hasNewerAttemptForSameAbility` 的邏輯——必須用一個真正單調遞增、不受用戶端時鐘
影響的欄位重現同一個保證，用 `reviewed_at` 時間戳記不夠精確（理論上可能相同或亂序）。

### `user_preferences`
```
user_id                 uuid primary key references auth.users(id) on delete cascade
daily_question_count    integer not null default 10 check (daily_question_count in (5,10,15,20))
daily_new_item_cap      integer not null default 10 check (daily_new_item_cap > 0 and daily_new_item_cap <= 50)
updated_at              timestamptz not null default now()
```
`daily_new_item_cap` 是本輪新增的偏好（PRODUCT 要求「每日新字上限，預設 10」）；
B 需要把它接進 `buildTodayQueue(...)` 呼叫端目前傳 `questionCount` 當
`newItemLimit` 的位置（`src/app/page.tsx`、`src/app/study/sessionInit.ts` 等），改傳這個
獨立設定值，預設 10 讓現有行為不明顯改變。

## RLS 政策（`to authenticated`；`(auth.jwt() ->> 'client_id') IS NULL` 代表「只有這個
App 自己的一般登入 session，不是 MCP／OAuth client 拿到的 token」——這是唯一 MCP
權限窄化的依據，見 Supabase 官方 OAuth Server 文件的 `client_id` claim）

- `learning_items`：SELECT（`auth.uid()=user_id`，MCP 可讀，供 inventory／context 使用）；
  INSERT／UPDATE（`auth.uid()=user_id`，MCP 與 App 都可以——MCP 的 `add_vocabulary_batch`
  需要 INSERT 權限；UPDATE 是給 App 的 RPC 更新 `status` 用，MCP 不會呼叫 UPDATE 但沒有
  技術理由禁止讀寫自己新增的欄位）；DELETE（`auth.uid()=user_id AND (auth.jwt()->>'client_id') IS NULL`
  —— **只有 App 自己能刪字，MCP 永遠不能刪**，直接對應 PRODUCT 的「不可刪除單字」）。
- `schedule_states`：SELECT（`auth.uid()=user_id`）；INSERT／UPDATE
  （`auth.uid()=user_id AND (auth.jwt()->>'client_id') IS NULL`，只有 App 走 RPC 寫）；
  沒有 DELETE 政策（沒有人需要直接刪，靠 `learning_items` 的
  `on delete cascade` 自然清除）。
- `review_attempts`：SELECT（`auth.uid()=user_id`，MCP 讀取用於 `get_learning_context`
  的正確率／提示率／錯題統計）；INSERT／UPDATE
  （`auth.uid()=user_id AND (auth.jwt()->>'client_id') IS NULL`，只有 App 的 RPC 寫，
  **MCP 永遠不能寫入或改動歷史作答**，對應 PRODUCT 的「不可改歷史 attempt」）；
  沒有 DELETE 政策。
- `study_sessions`：SELECT／INSERT／UPDATE 全部
  `auth.uid()=user_id AND (auth.jwt()->>'client_id') IS NULL`——**MCP 完全不能碰這張表**
  （4 個工具都用不到 session 明細，維持「窄權限」）。
- `user_preferences`：SELECT／INSERT／UPDATE 全部
  `auth.uid()=user_id AND (auth.jwt()->>'client_id') IS NULL`——同樣 MCP 完全不能碰。

上述任何一個 UPDATE 政策都必須同時寫 `USING` 與 `WITH CHECK`（否則能把一列的
`user_id` 改成別人的），INSERT 只需要 `WITH CHECK`，SELECT／DELETE 只需要 `USING`。

## RPC（只需要這 2 個；其餘操作都是單表單一陳述式，Postgres 本身已保證原子性，
不需要額外包 RPC——這是刻意的精簡，不是遺漏）

兩者都用預設的 `SECURITY INVOKER`（呼叫者的 RLS 照常套用，`auth.uid()` 是呼叫者），
**不要用 `SECURITY DEFINER`**（會繞過 RLS，且 `public` schema 下任何角色預設都能執行，
等同開一個公開的權限提升端點）。函式內任何一步失敗（`raise exception`）都會讓整個
函式的效果自動 rollback（Postgres 函式呼叫本身就是單一陳述式的事務邊界），這就是
PRODUCT 要求的「單一 transaction/RPC，不能拆成多個易部分成功的請求」。

客戶端（`SyncingLearningRepository`／`SyncEngine`）呼叫這兩個 RPC 時，**排程數值
（schedule／itemStatus）是本機已經用 `src/domain/srs.ts` 算好的最終結果，RPC 不重新
計算 SRS**——這是刻意的信任邊界：SRS 數學已经有 193 個測試在 TypeScript 驗證過，
在 SQL 重寫一份等於兩套邏輯要同步維護，且這是單人使用的個人資料，使用者「竄改自己
的複習排程」不是資訊安全問題（不影響其他使用者），真正的安全邊界是
`auth.uid() = user_id`（別人拿不到你的 token）與欄位 CHECK constraint（防止結構性壞
資料，例如負數 streak）。RPC 仍會重新核對 **結構性**不變量（session 存在且
`in_progress`、`sequence_in_session` 與 `planned_units` 對得上、冪等性），只是不重算
數學。

### `record_graded_attempt(payload jsonb) returns jsonb`

輸入形狀（`SyncingLearningRepository` 從 `recordGradedAttempt` 的 input 與回傳值組出來）：
```jsonc
{
  "session_id": "...", "learning_item_id": "...", "ability": "recall|reading",
  "exercise_id": "...", "exercise_type": "recall|reading|spelling|translation",
  "result": "correct|partial|incorrect", "used_hint": false, "response_time_ms": 1200,
  "reviewed_at": "2026-...Z",
  "schedule": { "due_at": "...", "interval_days": 1, "streak": 1, "lapse_count": 0 },
  "item_status": "new|learning|mastered|struggling",
  "session_completed": false, "session_completed_at": null
}
```
行為：
1. `select` session by `id=session_id and user_id=auth.uid()`；不存在或
   `status<>'in_progress'` → `raise exception`（呼叫端邏輯錯誤，比照本機同名檢查）。
2. 用 `(select count(*) from review_attempts where session_id=payload.session_id)`
   當 expected index，核對 `session.planned_units[expected_index]` 的
   `learningItemId`／`ability` 與 payload 相符（比照本機「精準修復 1」的檢查，這是
   結構性核對，不是重算 SRS）。
3. `insert into review_attempts (...) values (...) on conflict (session_id, exercise_id)
   do nothing returning id` → 若沒有回傳列（重複送出）：查現有列＋現有
   `schedule_states`／`learning_items.status`／`study_sessions` 現況，原樣回傳，
   **不做任何後續寫入**（冪等 no-op，這正是離線重送不會造成重複 attempt/session 的
   機制）。
4. 若有回傳列（第一次寫入）：
   - `insert into schedule_states (...) values (...) on conflict (learning_item_id, ability)
     do update set due_at=excluded.due_at, interval_days=excluded.interval_days,
     streak=excluded.streak, lapse_count=excluded.lapse_count,
     last_reviewed_at=excluded.last_reviewed_at, updated_at=now()`
   - `update learning_items set status=payload.item_status, updated_at=now()
     where id=payload.learning_item_id and user_id=auth.uid()`
   - `update study_sessions set status = case when payload.session_completed then 'completed'
     else status end, completed_at = payload.session_completed_at, updated_at=now()
     where id=payload.session_id and user_id=auth.uid()`
5. 回傳 `{ schedule, item_status, attempt, session }`（跟本機
   `RecordGradedAttemptResult` 同樣的欄位涵蓋範圍，命名可以是 snake_case，由 B 在
   `SyncEngine` 端做欄位名轉換，不需要 RPC 刻意輸出 camelCase）。

### `mark_attempt_correct(payload jsonb) returns jsonb`

輸入形狀：`{ session_id, exercise_id, schedule: {...同上}, item_status }`（不需要
`result`，一定是改成 `correct`）。行為：
1. 找 `review_attempts` by `(session_id, exercise_id)` and `user_id=auth.uid()`；
   不存在 → `raise exception`。
2. 若 `result='correct'` → 冪等：原樣回傳現況（`schedule_states`／`learning_items`／
   該筆 attempt），**不做任何寫入**（比照本機「已經是 correct 視為冪等」，即使這裡
   假設性地遇到寫入問題也不該報錯，因為根本沒有嘗試寫入）。
3. 核對「這是這個 session 目前最後一筆」：
   `not exists (select 1 from review_attempts where session_id=payload.session_id
   and sequence_in_session > target.sequence_in_session)`；不成立 → `raise exception`。
4. 核對「這個 (learning_item_id, exercise_type) 之後沒有更新的作答」（用 `seq`，
   不是 `reviewed_at`）：
   `not exists (select 1 from review_attempts where learning_item_id=target.learning_item_id
   and exercise_type=target.exercise_type and seq > target.seq)`；不成立 →
   `raise exception`（比照本機 P1 修復：拒絕會讓排程倒退的修正）。
5. 都通過：`update review_attempts set result='correct' where id=target.id`；
   upsert `schedule_states`（同上 on conflict do update）；`update learning_items
   set status=payload.item_status`。**不需要更新 `study_sessions`**（正規化後
   session 本身不存 exercise_results，這點跟本機版本不同，本機需要同步更新
   session.exerciseResults 陣列，這裡不用）。
6. 回傳同上形狀。

## Outbox 操作型別與對應的 Supabase 呼叫（B 負責實作，A 提供的 RPC／表是它的呼叫對象）

```ts
type OutboxOperation =
  | { type: "upsert_item"; payload: LearningItemRow }                       // guarded RPC
  | { type: "delete_items"; payload: { ids: string[] } }                    // guarded RPC
  | { type: "upsert_schedule_state"; payload: ScheduleStateRow }            // guarded RPC；僅 migration
  | { type: "upsert_session"; payload: StudySessionRow }                    // guarded RPC
  | { type: "abandon_session"; payload: { sessionId: string } }             // guarded RPC
  | { type: "record_graded_attempt"; payload: RecordGradedAttemptRpcInput } // .rpc('record_graded_attempt', {payload})
  | { type: "mark_attempt_correct"; payload: MarkAttemptCorrectRpcInput }   // .rpc('mark_attempt_correct', {payload})
  | { type: "upsert_preferences"; payload: UserPreferencesRow };            // guarded RPC
```
每筆 outbox entry：`{ id: string; type: OutboxOperation["type"]; payload: object;
createdAt: string; attempts: number; lastError?: string }`，存在獨立 localStorage key
（例如 `learning-language:sync-outbox`），與主要 `PersistedStore` 分開。outbox 讀取、解析或
寫入失敗會 fail closed 並保留原內容，不會過濾失敗項目、回退成空佇列或假裝已 enqueue。
另有 `upsert_review_attempt`（僅 migration 使用 guarded RPC）見下方 migration 一節。

### content-key 衝突與 canonical id alias（2026-09-19，見 `duplicateItemResolution.ts`）

`learning_items` 除了 `id` 主鍵，還有 `unique(user_id, content_key)`（見「資料表」一節）。
兩台裝置各自離線建立同一個單字時 id 不同、content_key 相同：先同步的裝置成功；另一台的
guarded insert 會撞 `unique(user_id, content_key)`。outbox 是嚴格 FIFO，必須先安全解析這筆，
不能跳過後續操作。

`resolveContentKeyConflict` 會讀遠端同 content_key 的 canonical item，並確認雙方 item 欄位
相容，而且遠端 canonical id 尚未被 schedule、attempt 或 session 引用。只有這個無進度案例
才把 `localId → canonicalId` 寫入帳號範圍的 append-only alias journal。local store 與既有
outbox 永遠保留原 id；送出網路前才把 item、schedule、attempt、session 巢狀引用轉成
canonical id，pull 回來時再轉成本機 id。journal 或 cache 任何讀寫／格式錯誤都會停止同步。

若雙方任一欄位不相容，或任一邊已經有進度，系統會把雙邊完整快照寫成持久化 unresolved
conflict，保留 outbox 首筆並停止 FIFO，不自動選較新排程、不刪任何一邊。alias journal 已寫入
但分頁中斷時，重試會從 journal 重建同一個一對一 mapping；已 alias 的重送仍會重新核對遠端
canonical item，不會把不同資料當成成功。

所有初始匯入寫入走 `*_guarded` RPC：既有列只有逐欄完全一致才視為冪等重送，差異一律保留
在 outbox。日常 `record_graded_attempt`／`mark_attempt_correct` 以同一 item＋ability 的
transaction advisory lock 序列化，並用呼叫端作答前看到的 `expected_schedule` 做 CAS；第二台
裝置若看到過期排程會收到 conflict，不會覆蓋第一台的新進度。作答使用本機穩定 attempt id，
相同 payload 重送可安全回傳，相同 session/exercise 的不同內容則拒絕。

## 一次性 migration（localStorage v2 → Supabase）＝ 重用 outbox，不要另寫一套

`runInitialMigration()`：
1. **偵測**：登入後，本機 store 任一集合非空，且
   `localStorage["learning-language:migration-completed:<user_id>"]` 不存在。
2. **備份**：把目前完整 `PersistedStore` JSON 存一份到
   `learning-language:store:pre-migration-backup:<timestamp>`（只新增、不覆蓋、
   永不自動刪除）。
3. **推送＝批次 enqueue**：依序把每個 `LearningItem` → `upsert_item`、每個
   `StudySession` → `upsert_session`、每個 `ReviewAttempt` → `upsert_review_attempt`、每個
   `ScheduleState` → `upsert_schedule_state`、最後 `UserPreferences`。ReviewAttempt
   需要先算出 `sequence_in_session`（遍歷該 attempt 所屬 session 的
   `exerciseResults`，用 `exerciseId` 找到原始 index）。這些操作全部走 guarded RPC，
   遠端已有不同內容時停止，不會以 upsert 覆蓋。全部進同一個 outbox，然後
   **await 完整 drain**（不是 fire-and-forget），過程中更新畫面進度。
4. **核對**：drain 完成後，以步驟 2 同一份 immutable manifest 為準，套用持久化 alias 後
   跟遠端對應資料逐筆核對——
   items 檢查每個本機 id 遠端是否存在；scheduleStates 檢查每個
   `(learningItemId, ability)`；reviewAttempts 額外核對 `learning_item_id`／
   `session_id` 是否跟本機一致（不是只看 id 存在）；studySessions 額外核對
   `plannedUnits` 引用的每個 `learningItemId` 是否都是遠端真的存在的項目。單純比
   `remoteCount >= localCount` 沒辦法抓到「筆數對但關聯錯」；
   preferences 沒有本機筆數概念，遠端存在一筆就算通過。
5. **標記完成＋顯示結果**：全部核對通過才寫入
   `migration-completed:<user_id>=true`，畫面顯示各類別筆數；任何一類不足，
   顯示「哪幾類尚未完成」並保留重試按鈕（重試永遠安全，見下）。
6. **絕不刪除本機資料**——成功後本機 store 繼續當作快取正常運作，不做任何清空。
7. **處理部分匯入**：guarded RPC 只接受完全相同的既有列，已完成的項目是 no-op；不同內容
   保留在 FIFO 與 conflict journal 等人工處理。migration 與背景 `kick()` 共用單一 promise
   chain，同一時間只有一輪 drain，避免兩個流程同時移除或重送同一筆。

## MCP（C 負責；四個工具全部走一般 Supabase client＋使用者的 OAuth access token，
RLS 自然生效，不使用 service role）

### Auth／OAuth
- 依 Supabase 官方文件 `https://supabase.com/docs/guides/auth/oauth-server/*`：
  Supabase Auth 本身就是 OAuth 2.1 Server（beta），簽出的 access token 是一般
  Supabase JWT，多一個 `client_id` claim。**MCP 不用自己實作 OAuth AS**，只要：
  1. 專案 Dashboard 啟用 OAuth Server（見文末 runbook，這是 dashboard beta 開關，
     C 無法自己開）＋設定 Authorization Path（建議 `/oauth/consent`）。
  2. `/mcp` 收到請求時，從 `Authorization: Bearer <token>` 抽 token，呼叫
     （用只帶 publishable key 建立的 client）`supabase.auth.getUser(token)` 驗證；
     失敗回 401 並帶 `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`。
  3. 驗證通過後，**用該 token 建立這次請求專用的 Supabase client**
     （`createClient(url, publishableKey, { global: { headers: { Authorization:
     'Bearer ' + token } } })`），所有查詢都用這個 client 送出，讓 RLS 用
     `auth.uid()` 自動限定成這個使用者、`client_id` claim 自動讓上面的 RESTRICTIVE
     範圍生效。**絕對不要在 `/mcp` 或任何工具程式碼裡用 `SUPABASE_SECRET_KEY`
     建 client**（service role 會繞過 RLS，等於幫每個 MCP client 開後門）。
  4. 建立 `src/app/.well-known/oauth-protected-resource/route.ts`：回傳
     `{ resource: "https://<host>/mcp", authorization_servers: ["<NEXT_PUBLIC_SUPABASE_URL>/auth/v1"] }`
     （MCP 用戶端會先讀這個，再去讀 Supabase 自己的
     `/.well-known/oauth-authorization-server/auth/v1`）。
  5. 建立 `/oauth/consent`（Server Component）＋
     `/api/oauth/decision`（Route Handler）：完全比照 Supabase 官方文件
     「Getting Started with OAuth 2.1 Server」的 Next.js 範例（`getAuthorizationDetails`
     / `approveAuthorization` / `denyAuthorization`），改成本專案的 zh-TW 文案與
     既有 Tailwind 視覺風格；未登入要導去 B 建立的 `/auth/sign-in`
     （帶回 `authorization_id`）。

### `/mcp` route（Node runtime，不是 Edge）
- `export const runtime = "nodejs"`。用 `@modelcontextprotocol/sdk`
  （已安裝 `^1.30.0`）的 Streamable HTTP transport；先讀套件內
  `node_modules/@modelcontextprotocol/sdk` 的型別與 README 確認目前這個版本的
  確切 API（SDK 版本更新頻繁，不要照記憶寫），再實作，不要臆測方法名稱。
- 4 個工具全部：輸入輸出都用 `zod` schema 定義（已安裝 `^4.6.5`）；讀取類工具
  標 `annotations: { readOnlyHint: true, destructiveHint: false }`；
  `add_vocabulary_batch` 標 `annotations: { readOnlyHint: false, destructiveHint: false,
  idempotentHint: true }` **並且在工具 description 文字裡明講「執行前必須先呼叫
  preview_vocabulary_batch 並取得使用者明確確認」**——因為不同 MCP host 對
  annotation 的支援程度不一，文字描述是唯一保證每個 host 都看得到的channel。

### 四個工具的資料邏輯（全部重用 `src/domain/*` 既有且已測試的純函式，
不要在 MCP 這層重新實作 SRS／統計數學）

1. **`get_learning_context({ days: 7 | 30 })`**：用該使用者的 client 查
   `learning_items`（依 language 分兩批或一次查完再用 language 分組）、
   `schedule_states`、`review_attempts`（`reviewed_at >= now()-days`）。用
   `src/domain/stats.ts` 的 `computeStatusCounts`／`computeAbilityStatusCounts`／
   `computeAccuracyOverWindow`／`computeHintRateOverWindow`／
   `computeUpcomingReviewOverview`，`src/domain/practice.ts` 的
   `buildWrongAnswerUnits`（錯題），組成輸出：每語言的
   `{ masteryBreakdown, dueCount, accuracy, hintRate, byAbility: {recall, reading},
   wrongAnswerCount, studyVolume }`。
2. **`get_vocabulary_inventory`**：查該使用者全部 `learning_items`（可加
   `limit`，預設例如 500，avoid 無上限查詢），依 `content_key` 分組找重複、依
   `tags` 分佈統計、依 `language`/`type` 分佈統計。
3. **`preview_vocabulary_batch(items)`**：**不寫入**。逐筆驗證必要欄位
   （`promptZh`/`answer` 必填；`reading`/`romaji`/`partOfSpeech`/`exampleSentence`/
   `tags` 可選但若提供必須是非空字串／字串陣列）；若提供 `romaji`，用
   `src/domain/romaji.ts` 的 `romajiMatchesReading(reading, romaji)` 核對，不一致
   時**不擋（不是 error）**，而是回報 warning 並附上系統推導的正確羅馬拼音；
   若沒提供 `romaji`，直接用 `toRomaji(reading)` 補上（不算 warning，這是正常
   補值）。查詢現有 `learning_items` 的 `content_key` 找出「已存在」重複，
   同時檢查批次內部彼此重複。回傳
   `{ validItems: [...含系統補值後的完整內容], duplicates: [...], errors: [...] }`。
4. **`add_vocabulary_batch({ items, confirm: true })`**：`confirm` 用
   `z.literal(true)`（不能省略、不能是 false），輸入形狀跟 preview 完全一樣的
   `items`。**重新完整跑一次跟 preview 一樣的驗證**（不信任呼叫端「已經 preview
   過」的宣稱，見下方安全理由），驗證通過的項目才
   `.upsert(rows, { onConflict: 'user_id,content_key', ignoreDuplicates: true })
   .select()`；比較輸入與回傳，回報 `{ inserted: [...], skippedDuplicates: [...],
   errors: [...] }`。新項目一律 `status: 'new'`、`source: 'ai'`——不需要另外實作
   「新字不要一次全塞進今天」的機制，`status:'new'` 的項目本來就只會被
   `buildTodayQueue` 依既有的每日新內容上限逐步排入，這是現有機制自然覆蓋的行為。

   **為什麼 add 要重新驗證，不能只信任「已 preview」**：MCP 呼叫是無狀態的
   HTTP 請求，且 preview 與 add 之間可能相隔任意時間（使用者在確認前跟真人或
   模型討論），這段時間資料庫可能已經改變（例如另一個裝置已經新增了同樣的字）；
   重新驗證是免費的（就是同一組查詢），比維護一個簽章 token 或伺服器端 session
   狀態更簡單、也更正確（不會有「token 過期」或「伺服器重啟遺失狀態」這類新故障
   模式，天然適配 serverless／Fluid Compute 的無狀態特性）。這是刻意不做
   簽章 preview token 的理由，不要另外加。

## 測試策略（真實 DB 部分，A／C 都會用到）

- Vitest 目前設定 `environment: "node"`、不會自動載入 `.env.local`。需要真實
  Supabase 連線的測試檔，在測試檔或一個共用 setup 檔開頭用 Node 內建
  `process.loadEnvFile('.env.local')`（Node 20.6+／本專案 `@types/node: ^26`
  肯定支援，不需要額外裝 `dotenv`）載入，並在檔案開頭偵測
  `process.env.SUPABASE_SECRET_KEY` 不存在時 `describe.skip`（讓沒有
  `.env.local` 的環境仍能跑 `npm test` 而不是整個失敗）。
- **驗證 RLS（含 `client_id` 限制）不需要真的走一次 OAuth flow**：Supabase 官方
  文件示範用 `SET request.jwt.claims = '{"sub":"...","role":"authenticated",
  "client_id":"..."}'` 在一般 SQL 連線裡模擬任意 JWT claims 直接測 policy——用
  `pg` 對 `POSTGRES_URL_NON_POOLING` 開連線，在測試裡對每個關鍵 policy 跑
  「這個 claims 組合應該擋下來／應該放行」的斷言，比架設整條 OAuth consent
  flow 更直接、更適合自動化測試。
- 需要真實使用者做整合測試時（不是只測 policy 本身），用
  `SUPABASE_SECRET_KEY` 建立 admin client，`supabase.auth.admin.createUser(...)`
  建立一到兩個測試帳號，測完在 `afterAll` 用
  `supabase.auth.admin.deleteUser(...)` 清除，不留測試帳號在 Production 專案裡。
- 任何測試輸出都不能印出 token／secret 的實際值，只能印布林、數量、id 等
  非敏感診斷資訊。

## 已知簡化（誠實標示，比照本檔既有風格，不是隱藏限制）

- Pull-merge 是「單一主要裝置＋離線間隙」模型：沒有做真正的多裝置即時
  雙向合併／欄位級衝突解決；本機有 pending outbox entry 時一律「本機優先」，
  沒有 pending entry 時一律「遠端覆蓋本機」。對「一支手機、偶爾離線」的實際
  使用情境已經足夠，多裝置同時離線編輯同一筆資料是本輪刻意不處理的情境。
- Migration／pull 都沒有做「遠端已刪除、本機還留著」的刪除同步（tombstone）；
  `removeItem`／`removeSeedItems` 的刪除靠 outbox 的 `delete_items` 正常推送，
  但反向（別的裝置刪除後，這台裝置的本機快取不會主動移除）不在本輪範圍內。
- MCP 沒有實作 dynamic client registration 的濫用防護（例如 client 白名單、
  註冊速率限制）——Supabase 官方文件本身也把這列為「啟用前要考慮」的項目；
  本輪預設走**手動預先註冊**單一 OAuth client（見 runbook），不啟用 dynamic
  registration，降低攻擊面，之後真的需要多個第三方 client 再評估開啟。
- `record_graded_attempt`／`mark_attempt_correct` 信任客戶端算好的 SRS 數值（見
  上方「為什麼」說明），不是重新計算——這對單人個人資料是合理取捨，但代表
  這兩個 RPC **不適合**未來如果這個專案變成多人共用／教師指派他人複習計畫的
  情境下直接沿用，屆時需要重新評估是否要把 SRS 計算搬進資料庫。

# 英文單字與片語練習：實作計畫

日期：2026-10-12
狀態：使用者已審核，2026-10-12 完成本機實作與驗證。交付與外部驗收界線見 [english-practice.md](english-practice.md)。以下保留原審核規格。

## 1. 目標與範圍

以增加字彙量、看懂日常／職場／技術英文為主；多益 550 是畢業前目標，不把 App 變成完整多益備考工具。口說繼續使用 GPT Web。

本次交付一條完整流程：GPT 整理單字與句子 → MCP 預覽／確認新增 → App 今日學習 → 保存作答 → 輪替句子與間隔複習 → 英文進度。

- 支援單字、片語／固定搭配，每筆聚焦一個指定詞義與詞性。
- 題型為「直接辨義」與「句中辨義」，第一版皆使用四選一，不強制拼字或自由中文輸入。
- 句子、選項、答案、中文翻譯與基本解析預先保存；App 練習時不呼叫 AI。
- 沿用現有 repository、StudySession、/study、outbox 與 SRS 核心，不另建英文 session 系統。
- 不包含聽力、口說、AI API、定時檢查、學習評估報告、自動修訂或日文內容重新生成。
- 30 個首批原創項目是試跑教材，不標示為官方多益題庫、完整課程或能力檢定。

## 2. 已確認的現況與必要缺口

本輪以本機原始碼為依據，未查詢真實學習帳戶或線上資料庫 schema。

| 已有能力 | 本次需要補上 |
| --- | --- |
| 首頁日／英切換，英文目前準備中 | 英文今日學習與單字庫入口 |
| LearningItem.language 已有 ja/en，type 已有 vocabulary/phrase/collocation | 指定詞義與多題變體結構、辨義能力 |
| MCP preview_vocabulary_batch/add_vocabulary_batch 接受 en | 目前只存單一 exampleSentence；擴充變體格式與驗證 |
| session 題目快照、變體曝光、延後驗證已有日文實作 | 抽出可共用部分，接入英文，保留既有日文行為 |
| repository 可依語言讀取資料 | 今日計畫、學習初始化與頁面多處仍固定 ja |
| 今日計畫有本機與 guarded RPC 同步 | 本機 validator、plan ID 與 reserve_daily_plan SQL 都需要支持 en |
| 排程能力目前 recall/reading | 英文新增 meaning，不挪用日文 reading，也不把理解答對當成產出能力 |

這不是只有首頁修改；需把內容傳輸、排程、作答證據與同步接起來。不得只改前端而漏掉 SQL／備份 validator，導致英文資料被拒絕或遺失。

## 3. 首批內容（建議預設，審核後才製作）

首批 30 個項目：20 個單字、10 個片語／搭配，涵蓋你日常與技術學習會遇到的內容。單一詞義可有多個分類標籤，不因標籤建立重複項目。

| 分類 | 單字 | 片語／搭配 |
| --- | --- | --- |
| 日常 | available、confirm、arrange、delay、request、provide、cancel | find out、pick up、look for |
| 多益／職場 | deadline、schedule、require、update、issue、responsible、attend | meet a deadline、be responsible for、follow up on、let someone know |
| 技術 | access、permission、account、secure、deploy、configure | access control、set up、back up |

規則：

- 先學常見指定用法，例如 issue（名詞：問題）、secure（形容詞：安全的）、back up（動詞：備份）。
- 多義字與片語不一次塞全部意思；不同詞義可另建項目，去重不能只看英文拼字。
- 片語需標示可替換成分與合理形式，例如 let someone know 可在句中呈現 let me know。
- 其他用字與句構保持簡單；單字難度先按實際試跑調整，不宣稱已做程度診斷。
- 每項 1 題直接辨義＋4 題不同情境的句中辨義，共 150 個題目變體；例句是原創，不使用私密工作內容。
- 至少 1 個情境變體預留後續驗證。預留只是出題安排，不代表使用者一定沒在 GPT 看過它。

## 4. 畫面與 UX

### 英文首頁

```text
[ 日文 | 英文（選中） ]

英文學習
累積單字，逐步看懂英文。

┌ 今日學習 ──────────────────┐
│ 到期複習＋依設定加入的新字    │
│ [ 開始／繼續上次學習 ]       │
└────────────────────────────┘

[ 查看單字與片語 ]

首頁          英文進度          設定
```

- 第一版只提供今日學習與單字庫，不加入新的一套自主練習分類。
- 沒有英文內容時，顯示去 GPT 預覽並確認加入的說明，不造假題數或啟動空 session。
- 底部進度依目前語言導向對應資料；設定維持共用。
- 每輪題數沿用設定；每日新項目上限先採各語言各自計算，使用同一個設定值。例如上限 5，日文最多 5、英文最多 5，需在設定說明清楚。
- 當天的新項目名單固定，不因切換語言、改上限或跨裝置操作反覆加額。預算與 reservation 均依 language/date 分開。

### 作答畫面

```text
英文學習                       2 / 10
句中辨義 · 單字

We're investigating a security issue.

issue 在這句裡是什麼意思？

[ 問題 ]  [ 帳戶 ]
[ 期限 ]  [ 許可 ]

[ 看提示 ]
```

作答後才展示中文翻譯、正確意思與基本解析；新字先有簡短介紹。看提示後答對、當輪重試答對，不當成無提示首次成功。

直接辨義題只呈現目標字／片語，測是否離開句子仍理解指定用法。多義詞在題幹提示本次詞性與學習範圍，不讓使用者猜隱藏的意思。

流程：英文首頁 → 介紹新項目／複習到期項目 → 四選一 → 顯示答案與解析 → 下一題 → 本輪結果。

單字庫／進度提供全部、日常、多益／職場、技術、單字／片語及學習狀態篩選；支援搜尋、展開內容、暫停／恢復，沿用現有資料安全語意。

## 5. 內容與作答資料

建議新增可選的 EnglishPractice 結構，放入 LearningItem 現有 learning_metadata 傳輸鏈；不把多句硬塞進 exampleSentence 或 explanation 字串。

建議欄位：

```text
LearningItem
  language: en
  type: vocabulary | phrase | collocation
  answer: 目標英文
  promptZh: 指定中文詞義
  partOfSpeech: 詞性
  tags: 分類
  contentVersion: 版本
  englishPractice:
    version: 1
    senseKey: 指定詞義識別
    variants:
      id: 穩定題目 ID
      mode: direct | context
      sentence: 英文句子（context 必填）
      targetText: 本句目標表達
      translationZh: 中文翻譯（作答後顯示）
      choices: 四個具穩定 ID 的選項
      correctChoiceId: 正確選項 ID
      explanationZh: 基本解析
      hint: 可選提示
      role: practice | verification
```

- 系統驗證格式、ID 不重複、四個選項不重複、正確選項存在、目標表達在句中、內容長度與數量上限。
- 詞形變化或片語替換由 targetText 明確表示，不做脆弱的純字串完全相等判斷。
- 語意正確性、干擾選項是否合理仍需 GPT 產出與內容審查；格式驗證不能保證英文語意正確。
- 同一詞義重複新增應去重；相同拼字、不同詞義應允許共存。
- 初期不新增既有項目的更新 MCP；新增時一次帶足變體。補充／修訂接口與定時檢查另案處理。
- 作答 evidence 保存 variantId、mode、內容版本、實際題目與選項快照、提示狀態及回答選項。
- 離線、備份匯出／匯入、outbox 與雲端讀回都必須保留這些欄位。舊備份沒有新欄位仍能讀取。
- 舊的英文項目不偷偷套用新能力或刪除舊紀錄：未具備 EnglishPractice 時，單字庫可顯示「待補練習內容」，本次不自動排成新辨義題。

## 6. 句子輪替、排程與能力證據

- 英文辨義新增 meaning 能力；日文 recall/reading 與其原有排程保持。
- 直接辨義與句中辨義均屬意思理解，但 evidence 記錄題型，進度分開顯示，不能把句中猜對宣稱為獨立認字。
- session 建立時選定題目與選項順序，固定快照；reload、繼續、跨裝置同步時不重新抽題。
- 出題優先使用尚未在 App 曝光的合格情境變體；已建立 session 中的題目也算曝光，不只看完成作答。
- 一般練習輪替直接辨義與情境題；同一輪不以多次出同一字灌高成功證據。
- 未到期熟悉項目不為湊題硬塞；當輪重試用於補強，不延長熟練證據。
- 每輪延後驗證沿用最多兩個的節奏。變體用完時標示「間隔後確認」，不假稱新情境。
- 基本 SRS 排程使用確定性規則；穩定理解必須具直接辨義與句中辨義各自的合格證據，不能互相替代。
- 建議沿用現有產品的延後驗證門檻：每種題型兩次到期首次、無提示、跨日且至少七天間隔的成功，再安排 30／60 天確認；這是排程產品預設，不是宣稱具備聽力、口說或海外工作能力。
- 「已會」、暫停、恢復保留既有兩次確認與歷史；不自動造 correct、不刪排程、不清 outbox。

## 7. MCP 新增流程

優先擴充現有 preview_vocabulary_batch / add_vocabulary_batch，而不是做第二套批次新增。

1. GPT 依接口描述準備目標字、指定詞義與完整題目變體。
2. preview 驗證每筆資料，回報可新增、重複、錯誤與警告。
3. 使用者看到單字／詞義、變體數與代表句；若展開其他變體，不宣稱這些題目完全未知。
4. 使用者確認後，add(confirm=true) 重新驗證並寫入，全部為新／未學項目。
5. App 讀回內容，新字先介紹，再納入今日計畫。

MCP 描述必須說明：不得捏造學習狀態；不因 GPT 曾介紹過就把資料標成熟練。舊日文 payload、工具名稱、preview/add 確認流程保持相容。查詢工具同步納入英文內容與新欄位，避免新增成功但庫存／上下文讀不到。

首批教材另提供 MCP-compatible 批次 JSON，每批至多 10 個項目，不附 confirm=true。教材本機檔與隔離測試可以實作；真正加入使用者帳戶須走預覽確認。

## 8. 實作順序與改動區域

### A. 內容與能力契約

- domain/types、abilities、exercises、grading、queue、learningRules、automaticVerification：新增英文辨義與變體處理。
- 新增專注英文內容的模組與首批教材檔，重用快照／曝光 primitives；不改日文教材。
- repository/schema、備份 validator、baseRepository 與同步轉換：新欄位與 meaning 能力完整讀寫，資料不因 sanitization 消失。

### B. 雲端與 MCP 配套

- MCP vocabulary batch schema／validator／insert／preview／inventory／context 與 supabaseRows：完整接上 EnglishPractice。
- 檢查所有 SQL ability 約束、attempt/session/schedule guarded RPC、JSONB snapshot/evidence 驗證、語言與 ownership 檢查。
- 建立向後相容 migration：允許 meaning，讓 daily plan validator／reservation 依 payload.language 過濾資料並核對相同語言，保留既有日文 plan ID 與語意。
- 防止英日跨語言 item/session/plan/attempt 引用、繞過答案與內容版本驗證。
- 本機 SQL 模擬驗證通過後才準備發布。不得假設 JSONB 存得進去就代表 guarded replay 能接受。

### C. 學習與進度 UI

- 首頁、PracticeLauncher 的共用資料讀取、/study 的 dailyPlan/sessionInit/page：明確傳遞語言。
- /study?language=en、/progress?language=en 使用明確語言參數；既有未指定的 /study、/progress 預設 ja，保留舊連結語意。
- 已開啟的學習頁語言固定；首頁切換不改進行中的題目，也不放棄另一語言 session。
- 英文題型名稱、lang=en、單字庫、進度、暫停／恢復與 empty/error 狀態。
- 閱讀相關 Next.js 本機版本文件後修改；確認手機觸控、鍵盤操作與明暗模式。

### D. 驗證與交付

- 完成下方驗收項目、文件與日誌，遞增 PWA shell 版本。
- 回報修改、測試與未驗證的外部項目，提供本機手機尺寸畫面。

## 9. 驗收條件

### 自動化測試

- MCP preview/add 接受正確英文批次；錯誤變體逐筆拒絕；重複詞義不重複新增；不同詞義可共存；舊日文 payload 不退化。
- meaning 不混入日文 reading／產出證據；直接／情境成功各自計算。
- 同日英日計畫、當日新字上限、未完成 session 互不污染；reload 固定題目／選項。
- 曝光輪替、預留題、變體耗盡、新版本不借舊證據、提示與重試不造熟練。
- 備份 round-trip、舊 schema 相容、MCP DB→本機→snapshot→outbox→SQL replay 欄位與 IDs 保留。
- 本機 SQL 測試驗證新增 ability、跨語言拒絕、ownership、答案／版本核對、冪等 replay；不只核對資料筆數。
- npm test、npm run typecheck、npm run lint、npm run build。

### 本機瀏覽器驗收

- 隔離 guest 測试資料：新增英文，開始一輪、提示、答錯、重試、完成、繼續／reload、暫停／恢復、英文進度。
- 語言切換、日文原流程回歸、空內容、存取失敗、離線已有內容仍可練習。
- 手機尺寸無水平溢出，明暗模式可辨讀，無本次功能引起的 console error/warn。

### 外部驗收邊界

本機測試／SQL 模擬不等於真實 MCP OAuth、Production、登入帳戶同步、跨裝置或實體手機 PWA 通過。後續發布時需要對應 migration、正式 MCP 新增與登入作答的明確授權及驗收。

## 10. 審核與授權

本計畫建議的產品選擇：30 個首批項目、四選一辨義、每項 1＋4 題、無 AI API、每語言每日新字上限分開、meaning 能力與兩種題型的證據分開。

使用者確認後才實作本機程式、教材、migration 與測試。既有未提交修改全部保留；不自動 commit、push、部署、套用線上 migration 或寫入真實學習帳戶。本次英文完成後，再另行規劃定時檢查。

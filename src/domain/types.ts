/**
 * 核心領域模型。
 *
 * 設計原則：
 * - LearningItem／Exercise／ReviewAttempt／ScheduleState／StudySession 明確分離，
 *   避免把「內容」「出題」「作答紀錄」「排程狀態」「單次學習」混成一個大物件。
 * - `language` 與 `type` 從第一版就存在，即使本階段 UI 只完整支援 ja + vocabulary，
 *   之後加入 en 或 grammar/phrase/collocation 不需要改資料模型邊界。
 * - ReviewAttempt／ScheduleState／StudySession 都冗餘存一份 `language`，
 *   讓 repository 層可以直接依語言過濾，避免日文／英文資料在查詢時互相污染。
 *
 * 2026-09-14 repair batch（schemaVersion 2）新增：
 * - ScheduleState 改成以「(learningItemId, ability) 一組」為一筆排程，不再是每個項目
 *   只有一份共用進度。這樣含漢字讀音的單字，recall（中文→日文）與 reading（漢字→假名）
 *   各自有獨立的到期日／連續答對次數／失誤次數，出題與 mastery 判斷才不會被其中一項
 *   蓋過另一項（見 src/domain/abilities.ts、src/domain/srs.ts 的 combineAbilityStatuses）。
 * - StudySession 新增 `status` 與 `plannedUnits`，讓「今日學習」在中途重新整理後可以從
 *   repository 恢復同一個 session，而不是只存在 React state 裡。
 */

export type Language = "ja" | "en";

export type ItemType = "vocabulary" | "grammar" | "phrase" | "collocation";

/** ai：AI 教練建議（本階段未串接，保留欄位）。textbook/teacher/song/manual 為使用者可選來源。 */
export type ItemSource = "ai" | "textbook" | "teacher" | "song" | "manual";

/**
 * new：任何一項必要能力都還沒有排程紀錄（完全沒學過）。
 * mastered：所有必要能力都各自達到穩定門檻（見 srs.ts 的 combineAbilityStatuses）。
 * struggling：至少一項必要能力經常答錯。
 * learning：其餘情況（已經開始學，但還沒全部達標）。
 */
export type ItemStatus = "new" | "learning" | "mastered" | "struggling";

export interface LearningItem {
  id: string;
  language: Language;
  type: ItemType;
  /** 中文提示 */
  promptZh: string;
  /** 目標語言答案（日文漢字／假名、英文單字等） */
  answer: string;
  /** 假名讀音等輔助讀音；日文漢字題會用到 */
  reading?: string;
  /** 簡短說明，可選 */
  explanation?: string;
  /**
   * 羅馬拼音；MCP 匯入時由 `src/domain/romaji.ts` 從 `reading` 確定性推導或驗證
   * （2026-09-16 雲端化新增，可選欄位，向後相容，不需要 schemaVersion 升版）。
   */
  romaji?: string;
  /** 詞性（例：名詞／動詞／い形容詞），自由文字，不做枚舉限制 */
  partOfSpeech?: string;
  /** 例句，可選 */
  exampleSentence?: string;
  source: ItemSource;
  tags: string[];
  status: ItemStatus;
  /** ISO 時間字串 */
  createdAt: string;
  /** true 代表這是系統提供的範例內容，不是使用者真實學習資料 */
  isSeed: boolean;
}

export type ExerciseType = "recall" | "reading" | "spelling" | "translation";

/**
 * 單字目前實際會被排程的「能力」子集合。之後 grammar/phrase/collocation 或英文拼字題
 * 需要更多能力種類時，在這裡擴充，不影響既有 recall/reading 的行為。
 */
export type AbilityKind = Extract<ExerciseType, "recall" | "reading">;

export interface Exercise {
  id: string;
  exerciseType: ExerciseType;
  /** 目前每題只對應一個 LearningItem，保留陣列以支援未來句子題關聯多個項目 */
  learningItemIds: string[];
  prompt: string;
  expectedAnswer: string;
  createdAt: string;
}

export type AttemptResult = "correct" | "partial" | "incorrect";

export interface ReviewAttempt {
  id: string;
  exerciseId: string;
  /** 冗餘存主要作答對象，方便直接依項目／語言查詢，不用每次 join Exercise */
  learningItemId: string;
  language: Language;
  exerciseType: ExerciseType;
  sessionId: string;
  result: AttemptResult;
  usedHint: boolean;
  responseTimeMs: number;
  /** ISO 時間字串 */
  reviewedAt: string;
}

/**
 * 一個 LearningItem 的其中一項能力（recall 或 reading）的排程狀態。
 * 同一個 LearningItem 最多對應兩筆 ScheduleState（recall 一定有；reading 只有在
 * `requiredAbilities()` 判斷該項目需要獨立讀音練習時才會建立）。
 */
export interface ScheduleState {
  learningItemId: string;
  ability: AbilityKind;
  language: Language;
  /** 下次到期時間，ISO 字串 */
  dueAt: string;
  /** 這次排到的複習間隔天數 */
  intervalDays: number;
  /** 連續「答對」次數，決定下一次間隔與是否達到 mastered 門檻 */
  streak: number;
  /** 累計「答錯」次數，決定是否標為 struggling */
  lapseCount: number;
  /** 最近一次作答時間，ISO 字串；尚未作答過則為 undefined */
  lastReviewedAt?: string;
}

export interface StudySessionExerciseResult {
  exerciseId: string;
  learningItemId: string;
  exerciseType: ExerciseType;
  result: AttemptResult;
  usedHint: boolean;
  responseTimeMs: number;
}

/** session 建立當下就決定好的固定題目順序，重新整理後靠這個恢復，不重新排序。 */
export interface StudySessionPlannedUnit {
  learningItemId: string;
  ability: AbilityKind;
  kind: "review" | "new";
}

export type StudySessionStatus = "in_progress" | "completed" | "abandoned";

export interface StudySession {
  id: string;
  language: Language;
  status: StudySessionStatus;
  /** ISO 時間字串 */
  startedAt: string;
  /** 只有 status === "completed" 時才會設定 */
  completedAt?: string;
  /** session 建立當下就固定的題目順序；重新整理後用這個 + exerciseResults 的長度恢復進度 */
  plannedUnits: StudySessionPlannedUnit[];
  /** 依作答順序累積，長度即「已完成幾題」，索引對應 plannedUnits 的同一個位置 */
  exerciseResults: StudySessionExerciseResult[];
  /** 本次 session 中被當作「新內容」引入的 LearningItem id（去重後） */
  newItemIds: string[];
  /** 本次 session 中被當作「到期複習」處理的 LearningItem id（去重後） */
  reviewItemIds: string[];
}

/** 新增學習項目時的輸入型別；id／status／createdAt 由 repository 產生 */
export interface NewLearningItemInput {
  language: Language;
  type: ItemType;
  promptZh: string;
  answer: string;
  reading?: string;
  explanation?: string;
  romaji?: string;
  partOfSpeech?: string;
  exampleSentence?: string;
  source: ItemSource;
  tags: string[];
  isSeed?: boolean;
}

/**
 * Repository 抽象介面。
 *
 * 所有頁面／domain 邏輯只依賴這個介面，不直接碰 localStorage。
 * 之後要換成雲端資料庫，只需要新增一個實作這個介面的 class，
 * 呼叫端（頁面元件）完全不用改。
 *
 * 2026-09-14 repair batch（R3／R4）：
 * - 「評分＋更新排程＋更新 item status＋新增 attempt＋更新 session」收斂成
 *   `recordGradedAttempt` 一次呼叫，內部是單一原子寫入（見 baseRepository.ts 的
 *   copy-on-write commit），不會出現「schedule 更新成功、attempt 卻沒存到」這種半套狀態。
 * - 新增 in-progress session 概念（`getOrCreateInProgressSession`／`abandonSession`），
 *   讓「今日學習」中途重新整理後可以從 repository 持久化資料恢復，不是只存在 React state。
 * - 所有會寫入的方法現在都可能丟出 `PersistenceFailedError`（見 errors.ts）；
 *   呼叫端必須 try/catch 並把失敗清楚呈現給使用者，不能假裝成功。
 * - 新增 `durability`，讓 UI 能分辨目前是不是退回純記憶體模式（重新整理會遺失資料）。
 */

import type {
  AbilityKind,
  Language,
  LearningItem,
  NewLearningItemInput,
  ReviewAttempt,
  ScheduleState,
  StudySession,
  StudySessionPlannedUnit,
} from "../domain/types";
import type { AttemptResult, ExerciseType, ItemStatus } from "../domain/types";

export interface LanguageFilter {
  language?: Language;
}

export interface StudySessionFilter extends LanguageFilter {
  limit?: number;
  /** 預設只回傳 completed；傳 "all" 才會包含 in_progress／abandoned。 */
  status?: "completed" | "all";
}

export interface RecordGradedAttemptInput {
  sessionId: string;
  learningItemId: string;
  ability: AbilityKind;
  exerciseId: string;
  exerciseType: ExerciseType;
  result: AttemptResult;
  usedHint: boolean;
  responseTimeMs: number;
  now: Date;
}

export interface RecordGradedAttemptResult {
  schedule: ScheduleState;
  itemStatus: ItemStatus;
  attempt: ReviewAttempt;
  session: StudySession;
}

export interface MarkAttemptCorrectInput {
  sessionId: string;
  /** 這一題的 exerciseId，必須是這個 session 目前最後一筆作答紀錄（僅能在下一題前修正）。 */
  exerciseId: string;
}

/** localStorage 持久（重新整理不會遺失） vs. 純記憶體（這次分頁關掉／整理就遺失）。 */
export type RepositoryDurability = "persistent" | "volatile";

export interface LearningRepository {
  readonly durability: RepositoryDurability;

  listItems(filter?: LanguageFilter): LearningItem[];
  getItem(id: string): LearningItem | undefined;
  addItem(input: NewLearningItemInput): LearningItem;
  /** 以內容去重後原子加入整批項目；全部已存在時不寫入並回傳空陣列。 */
  addItemsIfMissing(inputs: NewLearningItemInput[]): LearningItem[];
  removeItem(id: string): void;
  /** 依語言移除所有種子範例資料，回傳實際移除的項目數 */
  removeSeedItems(language?: Language): number;

  listScheduleStates(filter?: LanguageFilter): ScheduleState[];
  getScheduleState(learningItemId: string, ability: AbilityKind): ScheduleState | undefined;

  listReviewAttempts(filter?: LanguageFilter): ReviewAttempt[];

  listStudySessions(filter?: StudySessionFilter): StudySession[];
  /** 目前這個語言是否有尚未完成的 session（用於「今日學習」重新整理後恢復）。 */
  getInProgressSession(language: Language): StudySession | undefined;
  /**
   * 有進行中 session 就直接回傳它（忽略傳入的 plannedUnits，因為題目順序在建立當下
   * 就已經固定）；沒有的話用傳入的 plannedUnits 建立一個新的並立即保存為 in_progress。
   * 同一語言同時只會有一個 in_progress session。
   */
  getOrCreateInProgressSession(language: Language, plannedUnits: StudySessionPlannedUnit[], now: Date): StudySession;
  /**
   * 評分一題：計算下一個排程、更新該項目狀態、新增一筆 ReviewAttempt、更新對應 session
   * 的 exerciseResults；全部在同一次原子寫入內完成。若這一題剛好是 session 的最後一題，
   * 同一次寫入也會把 session 標成 completed。
   */
  recordGradedAttempt(input: RecordGradedAttemptInput): RecordGradedAttemptResult;
  /**
   * 「我其實答對了」修正：把剛剛評分為 incorrect 的最後一題改判為 correct。
   * 只能修正這個 session 目前最後一筆作答（`session.exerciseResults` 的最後一筆，
   * 也就是「下一題」開始之前），不會新增第二筆 attempt——直接原地更新既有的
   * ReviewAttempt／StudySessionExerciseResult，並且用「重新套用這個 (item, ability)
   * 在這筆之前的作答序列＋這次改成 correct」重新推導排程，讓結果跟「當初就直接答對」
   * 完全一致，而不是在錯誤已經套用的排程上再疊加一次修正。
   * itemStatus／schedule／session 三者在同一次原子寫入內一起更新。
   *
   * 額外限制（P1 修復）：這筆必須同時是這個 (learningItemId, ability) **全域最新**的
   * 一筆 attempt——如果之後（不論哪個 session）已經有更新的一筆，代表目前排程已經是
   * 依那筆之後累積出來的，修正這筆舊的會讓排程倒退，會被拒絕、store 完全不變。目標
   * 已經是 correct 時視為冪等，直接回傳目前狀態，不會有任何寫入。
   */
  markAttemptCorrect(input: MarkAttemptCorrectInput): RecordGradedAttemptResult;
  /** 放棄目前這個 in_progress session：標記 abandoned，不刪除已經產生的 attempt／排程。 */
  abandonSession(sessionId: string): void;
}

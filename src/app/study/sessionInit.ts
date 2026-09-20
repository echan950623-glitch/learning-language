/**
 * `/study` 頁掛載時的初始化決策，抽成不依賴 React 的純函式（依賴 repository 做 I/O，
 * 但邏輯本身確定、可用真正的 repository 實例測試），這樣「資料缺口需要放棄舊 session、
 * 但放棄本身失敗」這種分支才有自動化測試覆蓋，不是只能靠人工在瀏覽器裡點一次確認。
 *
 * 第三輪修復（精準修復 3）：舊版在 `abandonSession` 失敗時用空 catch 吞掉錯誤，
 * 直接繼續往下建立新 session——等於假裝放棄成功。這裡改成：放棄失敗就直接回報錯誤，
 * 不再呼叫 `getOrCreateInProgressSession`，也不會把那個已經判定有資料缺口的舊 session
 * 當成可用的 active 狀態。
 */

import type { Language, LearningItem, StudySession, StudySessionPlannedUnit } from "@/domain/types";
import { buildTodayQueue, limitTodayQueue } from "@/domain/queue";
import { describePersistenceError, type LearningRepository } from "@/repository";
import {
  DEFAULT_DAILY_NEW_ITEM_CAP,
  DEFAULT_STUDY_QUESTION_COUNT,
  type DailyNewItemCap,
  type StudyQuestionCount,
} from "@/lib/studyPreferences";

export interface SessionResumeEvaluation {
  /** 這個 in_progress session 是否可以直接恢復（尚未作答的題目引用的項目都還存在）。 */
  canResume: boolean;
  /** exerciseResults.length，同時是恢復後應該從第幾題繼續。 */
  resumeIndex: number;
}

export interface AttemptSubmissionSnapshot {
  session: StudySession | undefined;
  currentIndex: number;
  learningItemId: string;
  ability: StudySessionPlannedUnit["ability"];
}

/**
 * 學習頁可能在背景 pull-merge 完成前已經載入舊 session。送出前以最新 repository 快照
 * 再核對一次位置；不同就要求重新載入，不能把舊畫面的答案套到另一題或已完成的 session。
 */
/**
 * 核對結果。失敗時一定帶著「是哪一項對不上」與具體數值——這個訊息會直接顯示在學習頁上，
 * 讓實機上的失敗自己說明原因，不必再另外開診斷面板比對。
 */
export type AttemptSubmissionCheck =
  | { current: true }
  | { current: false; reason: AttemptSubmissionMismatch; detail: string };

export type AttemptSubmissionMismatch =
  | "session_missing"
  | "session_not_in_progress"
  | "index_mismatch"
  | "unit_missing"
  | "item_mismatch"
  | "ability_mismatch";

export function checkAttemptSubmission(snapshot: AttemptSubmissionSnapshot): AttemptSubmissionCheck {
  const { session, currentIndex, learningItemId, ability } = snapshot;
  if (!session) {
    return { current: false, reason: "session_missing", detail: `本機已經找不到這筆 session（畫面在第 ${currentIndex + 1} 題）` };
  }
  if (session.status !== "in_progress") {
    return { current: false, reason: "session_not_in_progress", detail: `session 現在是 ${session.status}` };
  }
  if (session.exerciseResults.length !== currentIndex) {
    return {
      current: false,
      reason: "index_mismatch",
      detail: `畫面停在第 ${currentIndex + 1} 題，本機紀錄已經答到第 ${session.exerciseResults.length + 1} 題`,
    };
  }
  const expected = session.plannedUnits[currentIndex];
  if (!expected) {
    return { current: false, reason: "unit_missing", detail: `本機這筆 session 只有 ${session.plannedUnits.length} 題` };
  }
  if (expected.learningItemId !== learningItemId) {
    return {
      current: false,
      reason: "item_mismatch",
      detail: `這一題本機記的是 ${expected.learningItemId}，畫面上是 ${learningItemId}`,
    };
  }
  if (expected.ability !== ability) {
    return { current: false, reason: "ability_mismatch", detail: `這一題本機記的是 ${expected.ability}，畫面上是 ${ability}` };
  }
  return { current: true };
}

export function isAttemptSubmissionCurrent(snapshot: AttemptSubmissionSnapshot): boolean {
  return checkAttemptSubmission(snapshot).current;
}

/**
 * 純函式：判斷一個既有的 in_progress session 能不能直接恢復。
 * 「資料缺口」＝還沒作答的某個 planned unit 引用的 LearningItem 已經不存在
 * （例如中途在 /add 清除了這個 session 引用的範例資料）。
 */
export function evaluateSessionResume(
  session: Pick<StudySession, "exerciseResults" | "plannedUnits">,
  itemsById: Map<string, LearningItem>
): SessionResumeEvaluation {
  const resumeIndex = session.exerciseResults.length;
  const remaining = session.plannedUnits.slice(resumeIndex);
  const hasDataGap =
    resumeIndex > session.plannedUnits.length || remaining.some((unit) => !itemsById.has(unit.learningItemId));
  return { canResume: !hasDataGap, resumeIndex };
}

export type StudyInitResult =
  | { phase: "empty" }
  | {
      phase: "active";
      itemsById: Map<string, LearningItem>;
      session: StudySession;
      resumeIndex: number;
    }
  | { phase: "error"; message: string };

/**
 * `/study` 掛載時要做的事：
 * 1. 有可恢復的 in_progress session 就直接恢復。
 * 2. 沒有，或恢復不了（資料缺口）就放棄舊的、建立新的——但放棄失敗就停下來回報錯誤，
 *    不吞錯、不繼續、不假裝舊 session 是 active。
 * 3. 都沒有內容可學就是 empty。
 */
/**
 * 同一語言同時只該有一個 in_progress session（見 `getOrCreateInProgressSession`）。
 * 雲端已經觀察到十幾筆同時存在的 in_progress session——pull-merge 會把其他裝置／其他時間
 * 留下的 in_progress session 併回本機，`getInProgressSession` 只取陣列裡的第一筆，於是
 * 「恢復哪一筆」變得不確定，而且每次沒恢復到的那些會永遠留著，雲端跟著越積越多。
 *
 * 這裡在恢復之前先收斂：保留最新的一筆（`listStudySessions` 已依 startedAt 由新到舊排序），
 * 其餘標成 abandoned。abandoned 只改狀態，已產生的作答與排程完全保留，跟使用者自己按
 * 「放棄本次學習」是同一個領域操作。任何一筆放棄失敗就整個停下來回報，不繼續往下走。
 */
function reconcileInProgressSessions(
  repository: LearningRepository,
  language: Language
): StudySession | undefined | "abandon_failed" {
  const inProgress = repository
    .listStudySessions({ language, status: "all" })
    .filter((session) => session.status === "in_progress");
  if (inProgress.length === 0) return undefined;

  const [newest, ...stale] = inProgress;
  for (const session of stale) {
    try {
      repository.abandonSession(session.id);
    } catch {
      return "abandon_failed";
    }
  }
  return newest;
}

export function initializeStudySession(
  repository: LearningRepository,
  now: Date,
  questionCount: StudyQuestionCount = DEFAULT_STUDY_QUESTION_COUNT,
  newItemCap: DailyNewItemCap = DEFAULT_DAILY_NEW_ITEM_CAP
): StudyInitResult {
  const items = repository.listItems({ language: "ja" });
  const itemsById = new Map(items.map((item) => [item.id, item]));

  const existing = reconcileInProgressSessions(repository, "ja");
  if (existing === "abandon_failed") {
    return { phase: "error", message: "無法整理進行中的學習階段，請重新整理頁面後再試一次。" };
  }
  if (existing) {
    const { canResume, resumeIndex } = evaluateSessionResume(existing, itemsById);
    if (canResume) {
      return { phase: "active", itemsById, session: existing, resumeIndex };
    }

    try {
      repository.abandonSession(existing.id);
    } catch (error) {
      // 放棄失敗：已完成的 attempt／schedule 都還在（abandonSession 失敗代表連
      // 「標成 abandoned」這個變更本身都沒有寫入），但不能再假裝這個 session 可用，
      // 也不能繼續往下建立新 session（否則同語言會同時存在兩個 in_progress）。
      return { phase: "error", message: describePersistenceError(error) };
    }
  }

  return buildFreshSession(repository, items, itemsById, now, questionCount, newItemCap);
}

function buildFreshSession(
  repository: LearningRepository,
  items: LearningItem[],
  itemsById: Map<string, LearningItem>,
  now: Date,
  questionCount: StudyQuestionCount,
  newItemCap: DailyNewItemCap
): StudyInitResult {
  const scheduleStates = repository.listScheduleStates({ language: "ja" });
  const queueResult = limitTodayQueue(
    buildTodayQueue(items, scheduleStates, now, newItemCap),
    questionCount
  );

  if (queueResult.units.length === 0) {
    return { phase: "empty" };
  }

  const language: Language = "ja";
  const plannedUnits: StudySessionPlannedUnit[] = queueResult.units.map((u) => ({
    learningItemId: u.item.id,
    ability: u.ability,
    kind: u.kind,
  }));

  try {
    const session = repository.getOrCreateInProgressSession(language, plannedUnits, now);
    return { phase: "active", itemsById, session, resumeIndex: session.exerciseResults.length };
  } catch (error) {
    return { phase: "error", message: describePersistenceError(error) };
  }
}

/**
 * 送出前核對失敗（`isAttemptSubmissionCurrent` 回 false）之後要怎麼辦。
 *
 * 舊行為是直接停在原地、要使用者「重新載入最新進度」——但重新載入會重跑初始化，可能又
 * 建立一筆全新 session，使用者就會一直被彈回第一題，永遠答不完（2026-09-21 手機實測）。
 * 守門本身是對的（不能把答案寫到錯的位置），錯的是沒有出口。
 *
 * 這裡只讀 repository，判斷同一筆 session 現在真正的位置：
 * - `realign`：session 還在、還在進行中、而且還有下一題——把畫面對齊到它現在的位置，
 *   使用者就地重答那一題即可，不必重新載入、也不會多開一個 session。
 * - `reload`：session 不見了或已經結束，只能重新初始化。
 */
export type AttemptResync =
  | { kind: "realign"; session: StudySession; index: number }
  | { kind: "reload" };

export function resolveAttemptResync(
  repository: LearningRepository,
  sessionId: string,
  language: Language
): AttemptResync {
  const session = repository
    .listStudySessions({ language, status: "all" })
    .find((candidate) => candidate.id === sessionId);
  if (!session || session.status !== "in_progress") return { kind: "reload" };

  const index = session.exerciseResults.length;
  const unit = session.plannedUnits[index];
  if (!unit) return { kind: "reload" };

  const itemsById = new Map(repository.listItems({ language }).map((item) => [item.id, item]));
  if (!itemsById.has(unit.learningItemId)) return { kind: "reload" };

  return { kind: "realign", session, index };
}

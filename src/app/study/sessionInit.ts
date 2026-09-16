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
export function initializeStudySession(
  repository: LearningRepository,
  now: Date,
  questionCount: StudyQuestionCount = DEFAULT_STUDY_QUESTION_COUNT,
  newItemCap: DailyNewItemCap = DEFAULT_DAILY_NEW_ITEM_CAP
): StudyInitResult {
  const items = repository.listItems({ language: "ja" });
  const itemsById = new Map(items.map((item) => [item.id, item]));

  const existing = repository.getInProgressSession("ja");
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

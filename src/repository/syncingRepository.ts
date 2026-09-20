/**
 * 雲端同步的組合層：包一層 `LocalStorageLearningRepository`，本機讀寫完全走原本的
 * 同步路徑不變（見 ARCHITECTURE.md「核心決策」）。
 *
 * 規則（每個會寫入的方法都一樣）：
 * 1. 呼叫 inner 對應方法（完全不變、同步）——失敗就直接拋出，不寫 outbox（沒發生的事
 *    不用同步），呼叫端看到的行為跟今天完全一樣。
 * 2. 沒有丟例外 → 組一筆 outbox entry → enqueue（同步、localStorage）。
 * 3. `kick()`——非阻塞（不 await），背景嘗試 drain outbox。
 * 4. 立即回傳 inner 的結果，使用者體感速度不變。
 *
 * 這裡「成功」的定義是「inner 呼叫沒有丟例外」，不是「這次呼叫真的改變了什麼」——例如
 * `markAttemptCorrect`／`abandonSession` 對已經是目標狀態的輸入是冪等 no-op，這裡仍然
 * 會 enqueue；對應的 Supabase RPC／操作本身也設計成冪等（見 ARCHITECTURE.md 的 RPC
 * 行為說明），多送一次沒有副作用，換來的是實作簡單、不需要從回傳值反推「這次是不是
 * 真的有變更」。
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
import type { LocalStorageLearningRepository } from "./localStorageRepository";
import type {
  LanguageFilter,
  LearningRepository,
  MarkAttemptCorrectInput,
  RecordGradedAttemptInput,
  RecordGradedAttemptResult,
  RepositoryDurability,
  StudySessionFilter,
} from "./types";
import {
  enqueueOutboxEntries,
  enqueueOutboxEntry,
  learningItemToRow,
  outboxHasPendingSessionUpsert,
  studySessionToRow,
  type MarkAttemptCorrectRpcInput,
  type OutboxOperation,
  type RecordGradedAttemptRpcInput,
  type ExpectedScheduleState,
} from "./sync/outbox";
import { kick } from "./sync/syncEngine";

function buildRecordGradedAttemptPayload(
  input: RecordGradedAttemptInput,
  result: RecordGradedAttemptResult,
  expectedSchedule: ExpectedScheduleState | null
): RecordGradedAttemptRpcInput {
  return {
    attempt_id: result.attempt.id,
    session_id: input.sessionId,
    learning_item_id: input.learningItemId,
    ability: input.ability,
    exercise_id: input.exerciseId,
    exercise_type: input.exerciseType,
    result: input.result,
    used_hint: input.usedHint,
    response_time_ms: input.responseTimeMs,
    reviewed_at: result.attempt.reviewedAt,
    expected_schedule: expectedSchedule,
    schedule: {
      due_at: result.schedule.dueAt,
      interval_days: result.schedule.intervalDays,
      streak: result.schedule.streak,
      lapse_count: result.schedule.lapseCount,
    },
    item_status: result.itemStatus,
    session_completed: result.session.status === "completed",
    session_completed_at: result.session.completedAt ?? null,
  };
}

function buildMarkAttemptCorrectPayload(
  input: MarkAttemptCorrectInput,
  result: RecordGradedAttemptResult,
  expectedSchedule: ExpectedScheduleState
): MarkAttemptCorrectRpcInput {
  return {
    session_id: input.sessionId,
    exercise_id: input.exerciseId,
    expected_schedule: expectedSchedule,
    schedule: {
      due_at: result.schedule.dueAt,
      interval_days: result.schedule.intervalDays,
      streak: result.schedule.streak,
      lapse_count: result.schedule.lapseCount,
    },
    item_status: result.itemStatus,
  };
}

function scheduleExpectation(schedule: ScheduleState | undefined): ExpectedScheduleState | null {
  if (!schedule) return null;
  return {
    due_at: schedule.dueAt,
    interval_days: schedule.intervalDays,
    streak: schedule.streak,
    lapse_count: schedule.lapseCount,
    last_reviewed_at: schedule.lastReviewedAt ?? null,
  };
}

export class SyncingLearningRepository implements LearningRepository {
  private readonly inner: LocalStorageLearningRepository;
  private readonly userId: string;

  constructor(inner: LocalStorageLearningRepository, userId: string) {
    this.inner = inner;
    this.userId = userId;
  }

  get durability(): RepositoryDurability {
    return this.inner.durability;
  }

  private enqueueAndKick(operation: OutboxOperation): void {
    enqueueOutboxEntry(operation);
    kick();
  }

  // ---- 讀取：直接透傳，不做任何額外處理 ------------------------------------

  listItems(filter?: LanguageFilter): LearningItem[] {
    return this.inner.listItems(filter);
  }

  getItem(id: string): LearningItem | undefined {
    return this.inner.getItem(id);
  }

  listScheduleStates(filter?: LanguageFilter): ScheduleState[] {
    return this.inner.listScheduleStates(filter);
  }

  getScheduleState(learningItemId: string, ability: AbilityKind): ScheduleState | undefined {
    return this.inner.getScheduleState(learningItemId, ability);
  }

  listReviewAttempts(filter?: LanguageFilter): ReviewAttempt[] {
    return this.inner.listReviewAttempts(filter);
  }

  listStudySessions(filter?: StudySessionFilter): StudySession[] {
    return this.inner.listStudySessions(filter);
  }

  getInProgressSession(language: Language): StudySession | undefined {
    return this.inner.getInProgressSession(language);
  }

  // ---- 寫入：inner 不變 → 成功才 enqueue + kick ------------------------------

  addItem(input: NewLearningItemInput): LearningItem {
    const item = this.inner.addItem(input);
    this.enqueueAndKick({ type: "upsert_item", payload: learningItemToRow(item, this.userId) });
    return item;
  }

  addItemsIfMissing(inputs: NewLearningItemInput[]): LearningItem[] {
    const added = this.inner.addItemsIfMissing(inputs);
    if (added.length > 0) {
      enqueueOutboxEntries(
        added.map((item): OutboxOperation => ({ type: "upsert_item", payload: learningItemToRow(item, this.userId) }))
      );
      kick();
    }
    return added;
  }

  removeItem(id: string): void {
    this.inner.removeItem(id);
    this.enqueueAndKick({ type: "delete_items", payload: { ids: [id] } });
  }

  removeSeedItems(language?: Language): number {
    // `BaseLearningRepository.removeSeedItems` 只回傳「移除了幾筆」，沒有回傳實際的 id
    // 清單；要組出 `delete_items` 的 outbox payload，必須在真的呼叫 inner 移除、資料消失
    // 之前，先自己讀一次目前符合「種子資料」條件的 id（純讀取，不影響 inner 的行為或
    // 回傳的 count，兩者依然完全由 inner 決定）。
    const targetIds = this.inner
      .listItems(language ? { language } : undefined)
      .filter((item) => item.isSeed)
      .map((item) => item.id);

    const removed = this.inner.removeSeedItems(language);

    if (targetIds.length > 0) {
      this.enqueueAndKick({ type: "delete_items", payload: { ids: targetIds } });
    }
    return removed;
  }

  getOrCreateInProgressSession(
    language: Language,
    plannedUnits: StudySessionPlannedUnit[],
    now: Date
  ): StudySession {
    const session = this.inner.getOrCreateInProgressSession(language, plannedUnits, now);
    // 「建立」與「恢復既有 in_progress」都送一次 upsert_session：恢復時多送一次是無害的
    // 冪等 upsert，涵蓋「第一次建立當下 outbox 還沒送出、裝置就離線了」這種殘留情境。
    this.enqueueAndKick({ type: "upsert_session", payload: studySessionToRow(session, this.userId) });
    return session;
  }

  /**
   * session 不是一定經由這個 class 建立的：`/study` 恢復既有 in_progress session 時不會
   * 再呼叫 `getOrCreateInProgressSession`，而冷啟動時 auth 尚未 resolve 的那段時間，
   * `getRepository()` 回傳的是沒有 outbox 的純本機 repository——那段時間建立的 session
   * 從來沒有進過 outbox。作答 RPC 需要雲端已經有對應的 session 列，否則會永遠失敗在
   * `record_graded_attempt: session "…" 不存在`，而且它是 FIFO 首筆，後面全部跟著停擺。
   *
   * 所以這裡在 enqueue 作答之前先確認「這個 session 有沒有待送的建立操作」，沒有就用
   * **作答前**的 session 快照補一筆——刻意用作答前的狀態（必然是 in_progress、
   * completed_at 為 null），讓雲端重播的順序跟實際發生順序一致；直接拿本機最終
   * （可能已 completed）的狀態回填會讓後續作答撞上「session 已經是 completed」。
   * session 在整段進行中的欄位都不會變，所以雲端已經有同一列時，guarded RPC 逐欄核對後
   * 是無副作用的冪等成功。兩筆操作一次寫入 outbox，不會出現只寫到一半的順序。
   */
  recordGradedAttempt(input: RecordGradedAttemptInput): RecordGradedAttemptResult {
    const expectedSchedule = scheduleExpectation(this.inner.getScheduleState(input.learningItemId, input.ability));
    const sessionBeforeAttempt = this.inner
      .listStudySessions({ status: "all" })
      .find((session) => session.id === input.sessionId);
    const needsSessionUpsert =
      sessionBeforeAttempt !== undefined && !outboxHasPendingSessionUpsert(input.sessionId);

    const result = this.inner.recordGradedAttempt(input);

    const operations: OutboxOperation[] = [];
    if (needsSessionUpsert && sessionBeforeAttempt) {
      operations.push({ type: "upsert_session", payload: studySessionToRow(sessionBeforeAttempt, this.userId) });
    }
    operations.push({
      type: "record_graded_attempt",
      payload: buildRecordGradedAttemptPayload(input, result, expectedSchedule),
    });
    enqueueOutboxEntries(operations);
    kick();
    return result;
  }

  markAttemptCorrect(input: MarkAttemptCorrectInput): RecordGradedAttemptResult {
    const attempt = this.inner
      .listReviewAttempts()
      .find((candidate) => candidate.sessionId === input.sessionId && candidate.exerciseId === input.exerciseId);
    if (!attempt) {
      // inner 會產生既有的領域錯誤；這裡只避免在取得前置排程時製造不同的錯誤。
      return this.inner.markAttemptCorrect(input);
    }
    const ability: AbilityKind = attempt.exerciseType === "reading" ? "reading" : "recall";
    const expectedSchedule = scheduleExpectation(this.inner.getScheduleState(attempt.learningItemId, ability));
    if (!expectedSchedule) {
      return this.inner.markAttemptCorrect(input);
    }
    const result = this.inner.markAttemptCorrect(input);
    this.enqueueAndKick({
      type: "mark_attempt_correct",
      payload: buildMarkAttemptCorrectPayload(input, result, expectedSchedule),
    });
    return result;
  }

  abandonSession(sessionId: string): void {
    this.inner.abandonSession(sessionId);
    this.enqueueAndKick({ type: "abandon_session", payload: { sessionId } });
  }
}

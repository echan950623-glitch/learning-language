/** Local content and its pending operation are one account snapshot.
 * Browser callers must use mutateRepository / withDataLock so IndexedDB commits
 * before reporting success. Legacy standalone synchronous tests use localStorage.
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
  StudyMode,
  DailyPlan,
  LearningItemEdit,
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
  scheduleStateToRow,
  reviewAttemptToRow,
  type LearningEventPayload,
} from "./sync/outbox";
import { kick } from "./sync/syncEngine";
import { atomicAccountWrite, getAccountOwner } from "./accountStorage";
import { generateId } from "../domain/id";

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
  private inner: LocalStorageLearningRepository;
  private readonly userId: string;

  constructor(inner: LocalStorageLearningRepository, userId: string) {
    this.inner = inner;
    this.userId = userId;
    const mutations = new Set(["addItem", "addItemsIfMissing", "removeItem", "removeSeedItems", "getOrCreateInProgressSession", "recordGradedAttempt", "markAttemptCorrect", "abandonSession", "saveDailyPlan", "acknowledgeIntroduction", "recordHint", "skipVocabulary", "editItem"]);
    return new Proxy(this, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (!mutations.has(String(property))) return value.bind(target);
        return (...args: unknown[]) => {
          if (getAccountOwner() !== null && getAccountOwner() !== target.userId) throw new Error("帳戶已切換，舊畫面不能寫入。");
          // Inner copy-on-write commits its memory only after persistence; restore it if
          // the final encompassing snapshot/outbox commit fails.
          const checkpoint = target.inner.captureSnapshot();
          try { return atomicAccountWrite(() => value.apply(target, args)); }
          catch (error) { target.inner.restoreSnapshot(checkpoint); throw error; }
        };
      },
    });
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

  listDailyPlans(): DailyPlan[] { return this.inner.listDailyPlans(); }
  saveDailyPlan(plan: DailyPlan): DailyPlan {
    const saved = this.inner.saveDailyPlan(plan);
    if (saved.reservationOwner === this.userId) this.enqueueAndKick({ type: "learning_event", payload: { id: generateId("event"), kind: "plan", plan: saved } });
    return saved;
  }
  acknowledgeIntroduction(sessionId: string, itemId: string, now: Date, alreadyKnown = false): StudySession {
    const before = this.inner.listStudySessions({ status: "all" }).find(session => session.id === sessionId)!;
    const after = this.inner.acknowledgeIntroduction(sessionId, itemId, now, alreadyKnown);
    if (!before.understoodItemIds?.includes(itemId)) this.enqueueAndKick({ type: "learning_event", payload: {
      id: generateId("event"), kind: "introduction", beforeSession: studySessionToRow(before, this.userId),
      session: studySessionToRow(after, this.userId), item: learningItemToRow(this.inner.getItem(itemId)!, this.userId) } });
    return after;
  }
  skipVocabulary(sessionId: string, index: number, itemId: string, now: Date): StudySession {
    const before = this.inner.listStudySessions({ status: "all" }).find(session => session.id === sessionId)!;
    const after = this.inner.skipVocabulary(sessionId, index, itemId, now);
    this.enqueueAndKick({ type: "learning_event", payload: {
      id: generateId("event"), kind: "skip", beforeSession: studySessionToRow(before, this.userId), session: studySessionToRow(after, this.userId) } });
    return after;
  }

  recordHint(sessionId: string, index: number): StudySession {
    const before = this.inner.listStudySessions({ status: "all" }).find(session => session.id === sessionId)!;
    const after = this.inner.recordHint(sessionId, index);
    if (before.ruleVersion === 2 && !before.hintedIndices?.includes(index)) this.enqueueAndKick({ type: "learning_event", payload: {
      id: generateId("event"), kind: "hint", beforeSession: studySessionToRow(before, this.userId), session: studySessionToRow(after, this.userId) } });
    return after;
  }

  private eventPayload(kind: "attempt" | "correction", before: StudySession, previous: ScheduleState | undefined, result: RecordGradedAttemptResult): LearningEventPayload {
    const schedule = this.inner.getScheduleState(result.attempt.learningItemId, result.attempt.exerciseType === "reading" ? "reading" : "recall");
    return { id: generateId("event"), kind, beforeSession: studySessionToRow(before, this.userId), session: studySessionToRow(result.session, this.userId),
      item: learningItemToRow(this.inner.getItem(result.attempt.learningItemId)!, this.userId),
      attempt: reviewAttemptToRow(result.attempt, result.session.exerciseResults.findIndex(answer => answer.exerciseId === result.attempt.exerciseId), this.userId),
      beforeSchedule: previous ? scheduleStateToRow(previous, this.userId) : null, schedule: schedule ? scheduleStateToRow(schedule, this.userId) : null,
      plan: this.inner.listDailyPlans().find(plan => plan.id === result.session.dailyPlanId && plan.reservationOwner === this.userId) };
  }

  // ---- 寫入：inner 不變 → 成功才 enqueue + kick ------------------------------

  addItem(input: NewLearningItemInput): LearningItem {
    const item = this.inner.addItem(input);
    this.enqueueAndKick({ type: "upsert_item", payload: learningItemToRow(item, this.userId) });
    return item;
  }

  editItem(id: string, expectedVersion: number, input: LearningItemEdit, now: Date): LearningItem {
    const before = this.inner.getItem(id)!;
    const beforeSchedules = this.inner.listScheduleStates().filter(schedule => schedule.learningItemId === id);
    const item = this.inner.editItem(id, expectedVersion, input, now);
    this.enqueueAndKick({ type: "learning_event", payload: { id: generateId("event"), kind: "edit", beforeItem: learningItemToRow(before, this.userId), item: learningItemToRow(item, this.userId),
      beforeSchedules: beforeSchedules.map(schedule => scheduleStateToRow(schedule, this.userId)), schedules: this.inner.listScheduleStates().filter(schedule => schedule.learningItemId === id).map(schedule => scheduleStateToRow(schedule, this.userId)) } });
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
    const archivedAt = this.inner.getItem(id)?.archivedAt;
    if (archivedAt) this.enqueueAndKick({ type: "archive_items", payload: { ids: [id], archivedAt } });
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
      this.enqueueAndKick({ type: "archive_items", payload: { ids: targetIds, archivedAt: this.inner.getItem(targetIds[0])!.archivedAt! } });
    }
    return removed;
  }

  getOrCreateInProgressSession(
    language: Language,
    plannedUnits: StudySessionPlannedUnit[],
    now: Date,
    options?: { mode: StudyMode; dailyPlanId?: string; timeZone?: string }
  ): StudySession {
    const session = this.inner.getOrCreateInProgressSession(language, plannedUnits, now, options);
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
    const previous = this.inner.getScheduleState(input.learningItemId, input.ability);
    const expectedSchedule = scheduleExpectation(this.inner.getScheduleState(input.learningItemId, input.ability));
    const sessionBeforeAttempt = this.inner
      .listStudySessions({ status: "all" })
      .find((session) => session.id === input.sessionId);
    const needsSessionUpsert =
      sessionBeforeAttempt !== undefined && !outboxHasPendingSessionUpsert(input.sessionId);

    const result = this.inner.recordGradedAttempt(input);

    if (sessionBeforeAttempt?.ruleVersion === 2) {
      this.enqueueAndKick({ type: "learning_event", payload: this.eventPayload("attempt", sessionBeforeAttempt, previous, result) });
      return result;
    }

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
    const before = this.inner.listStudySessions({ status: "all" }).find(session => session.id === input.sessionId);
    if (before?.ruleVersion === 2) {
      const attempt = this.inner.listReviewAttempts().find(attempt => attempt.sessionId === input.sessionId && attempt.exerciseId === input.exerciseId)!;
      const previous = this.inner.getScheduleState(attempt.learningItemId, attempt.exerciseType === "reading" ? "reading" : "recall");
      const result = this.inner.markAttemptCorrect(input);
      if (attempt.result !== "correct") this.enqueueAndKick({ type: "learning_event", payload: this.eventPayload("correction", before, previous, result) });
      return result;
    }
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

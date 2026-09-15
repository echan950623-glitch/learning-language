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
import { combineAbilityStatuses, computeNextSchedule, deriveStatus, type SchedulePosition } from "../domain/srs";
import { requiredAbilities } from "../domain/abilities";
import { generateId } from "../domain/id";
import { nowIso } from "../domain/time";
import type {
  LanguageFilter,
  LearningRepository,
  MarkAttemptCorrectInput,
  RecordGradedAttemptInput,
  RecordGradedAttemptResult,
  RepositoryDurability,
  StudySessionFilter,
} from "./types";
import type { PersistedStore } from "./schema";

/**
 * 共用的存取／變更邏輯。
 *
 * 2026-09-14 repair batch（R4）：所有變更都走「copy-on-write」——複製一份完整 store、
 * 在複製品上修改、呼叫 `persistSnapshot(next)`；只有 `persistSnapshot` 沒有丟例外，
 * 才會把 `this.store` 換成新版本。這保證：
 * - 寫入失敗時 `this.store` 完全不變（不會出現「記憶體已經更新、但存檔沒成功」的分歧）。
 * - 多個欄位要一起變的操作（評分：排程＋item status＋attempt＋session）只要放在同一次
 *   clone→mutate→commit 裡，就是一次原子寫入，不會出現半套資料。
 */
export abstract class BaseLearningRepository implements LearningRepository {
  protected store: PersistedStore;
  abstract readonly durability: RepositoryDurability;

  protected constructor(initialStore: PersistedStore) {
    this.store = initialStore;
  }

  /**
   * 子類別實作：把 nextStore 寫進真正的儲存媒介。
   * 失敗必須 throw（建議 PersistenceFailedError）；成功就直接 return。
   * 呼叫端（commit）保證只有在這裡沒有丟例外時才會採用 nextStore。
   */
  protected abstract persistSnapshot(nextStore: PersistedStore): void;

  private commit(nextStore: PersistedStore): void {
    this.persistSnapshot(nextStore);
    this.store = nextStore;
  }

  private cloneStore(): PersistedStore {
    return {
      schemaVersion: this.store.schemaVersion,
      items: this.store.items.map((item) => ({ ...item, tags: [...item.tags] })),
      scheduleStates: this.store.scheduleStates.map((s) => ({ ...s })),
      reviewAttempts: this.store.reviewAttempts.map((a) => ({ ...a })),
      studySessions: this.store.studySessions.map((s) => ({
        ...s,
        plannedUnits: s.plannedUnits.map((u) => ({ ...u })),
        exerciseResults: s.exerciseResults.map((r) => ({ ...r })),
        newItemIds: [...s.newItemIds],
        reviewItemIds: [...s.reviewItemIds],
      })),
    };
  }

  private cloneSession(session: StudySession): StudySession {
    return {
      ...session,
      plannedUnits: session.plannedUnits.map((u) => ({ ...u })),
      exerciseResults: session.exerciseResults.map((r) => ({ ...r })),
      newItemIds: [...session.newItemIds],
      reviewItemIds: [...session.reviewItemIds],
    };
  }

  // ---- LearningItem -------------------------------------------------------

  listItems(filter?: LanguageFilter): LearningItem[] {
    const items = filter?.language
      ? this.store.items.filter((item) => item.language === filter.language)
      : this.store.items;
    return items.map((item) => ({ ...item, tags: [...item.tags] }));
  }

  getItem(id: string): LearningItem | undefined {
    const item = this.store.items.find((i) => i.id === id);
    return item ? { ...item, tags: [...item.tags] } : undefined;
  }

  addItem(input: NewLearningItemInput): LearningItem {
    const trimmedTags = input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    const item: LearningItem = {
      id: generateId("item"),
      language: input.language,
      type: input.type,
      promptZh: input.promptZh.trim(),
      answer: input.answer.trim(),
      reading: input.reading?.trim() || undefined,
      explanation: input.explanation?.trim() || undefined,
      source: input.source,
      tags: trimmedTags,
      status: "new",
      createdAt: nowIso(),
      isSeed: input.isSeed ?? false,
    };

    const next = this.cloneStore();
    next.items.push(item);
    this.commit(next);
    return item;
  }

  removeItem(id: string): void {
    const next = this.cloneStore();
    next.items = next.items.filter((item) => item.id !== id);
    next.scheduleStates = next.scheduleStates.filter((s) => s.learningItemId !== id);
    next.reviewAttempts = next.reviewAttempts.filter((a) => a.learningItemId !== id);
    this.commit(next);
  }

  removeSeedItems(language?: Language): number {
    const idsToRemove = new Set(
      this.store.items
        .filter((item) => item.isSeed && (!language || item.language === language))
        .map((item) => item.id)
    );
    if (idsToRemove.size === 0) return 0;

    const next = this.cloneStore();
    next.items = next.items.filter((item) => !idsToRemove.has(item.id));
    next.scheduleStates = next.scheduleStates.filter((s) => !idsToRemove.has(s.learningItemId));
    next.reviewAttempts = next.reviewAttempts.filter((a) => !idsToRemove.has(a.learningItemId));
    this.commit(next);
    return idsToRemove.size;
  }

  // ---- ScheduleState --------------------------------------------------------

  listScheduleStates(filter?: LanguageFilter): ScheduleState[] {
    const list = filter?.language
      ? this.store.scheduleStates.filter((s) => s.language === filter.language)
      : this.store.scheduleStates;
    return list.map((s) => ({ ...s }));
  }

  getScheduleState(learningItemId: string, ability: AbilityKind): ScheduleState | undefined {
    const state = this.store.scheduleStates.find(
      (s) => s.learningItemId === learningItemId && s.ability === ability
    );
    return state ? { ...state } : undefined;
  }

  // ---- ReviewAttempt --------------------------------------------------------

  listReviewAttempts(filter?: LanguageFilter): ReviewAttempt[] {
    const list = filter?.language
      ? this.store.reviewAttempts.filter((a) => a.language === filter.language)
      : this.store.reviewAttempts;
    return list.map((a) => ({ ...a }));
  }

  // ---- StudySession -----------------------------------------------------

  listStudySessions(filter?: StudySessionFilter): StudySession[] {
    let list = filter?.language
      ? this.store.studySessions.filter((s) => s.language === filter.language)
      : this.store.studySessions;

    // 預設只把「已完成」當成正式歷史；in_progress／abandoned 不該冒充完整紀錄
    // （R3：進度頁不能把進行中或放棄的 session 當成已完成歷史）。
    if ((filter?.status ?? "completed") === "completed") {
      list = list.filter((s) => s.status === "completed");
    }

    list = [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (filter?.limit !== undefined) {
      list = list.slice(0, filter.limit);
    }
    return list.map((s) => this.cloneSession(s));
  }

  getInProgressSession(language: Language): StudySession | undefined {
    const found = this.store.studySessions.find((s) => s.language === language && s.status === "in_progress");
    return found ? this.cloneSession(found) : undefined;
  }

  getOrCreateInProgressSession(
    language: Language,
    plannedUnits: StudySessionPlannedUnit[],
    now: Date
  ): StudySession {
    const existing = this.store.studySessions.find((s) => s.language === language && s.status === "in_progress");
    if (existing) {
      // 已經有進行中的 session：題目順序在建立當下就固定了，忽略這次傳入的候選佇列，
      // 直接恢復既有 session，同一語言同時只會有一個 in_progress（R3 要求）。
      return this.cloneSession(existing);
    }

    // 精準修復（第四輪）：真的要建立新 session 時，plannedUnits 必須是非空、且全部引用
    // 存在且語言一致的 LearningItem——否則寫出來的 in_progress session 會是
    // schema.ts 的 isStudySession／finalizeStore 之後重新解析 localStorage 時會丟棄的形狀
    // （in_progress 沒有下一題、或引用不到項目），造成「這次分頁還能用、重新整理後突然消失」
    // 的不一致。呼叫端邏輯錯誤，比照 recordGradedAttempt 的驗證風格丟一般 Error。
    if (plannedUnits.length === 0) {
      throw new Error("getOrCreateInProgressSession: plannedUnits 不能是空陣列，無法建立 session");
    }
    for (const unit of plannedUnits) {
      const referencedItem = this.store.items.find((i) => i.id === unit.learningItemId);
      if (!referencedItem || referencedItem.language !== language) {
        throw new Error(
          `getOrCreateInProgressSession: plannedUnits 內的 learningItemId "${unit.learningItemId}" 不存在，或語言與 session 的 "${language}" 不一致`
        );
      }
    }

    const dedupe = (ids: string[]): string[] => Array.from(new Set(ids));
    const session: StudySession = {
      id: generateId("session"),
      language,
      status: "in_progress",
      startedAt: now.toISOString(),
      plannedUnits: plannedUnits.map((u) => ({ ...u })),
      exerciseResults: [],
      newItemIds: dedupe(plannedUnits.filter((u) => u.kind === "new").map((u) => u.learningItemId)),
      reviewItemIds: dedupe(plannedUnits.filter((u) => u.kind === "review").map((u) => u.learningItemId)),
    };

    const next = this.cloneStore();
    next.studySessions.push(session);
    this.commit(next);
    return this.cloneSession(session);
  }

  abandonSession(sessionId: string): void {
    const existing = this.store.studySessions.find((s) => s.id === sessionId);
    if (!existing || existing.status !== "in_progress") {
      // 不存在，或已經不是 in_progress：視為已經處理過，冪等地什麼都不做。
      return;
    }
    const next = this.cloneStore();
    const session = next.studySessions.find((s) => s.id === sessionId);
    if (!session) return;
    session.status = "abandoned";
    this.commit(next);
  }

  // ---- 評分（R1 多能力排程 + R3 session 更新 + R4 原子寫入，合在一次 commit） ----

  recordGradedAttempt(input: RecordGradedAttemptInput): RecordGradedAttemptResult {
    const next = this.cloneStore();

    const item = next.items.find((i) => i.id === input.learningItemId);
    if (!item) {
      throw new Error(`recordGradedAttempt: learningItemId "${input.learningItemId}" 不存在，無法評分`);
    }

    const session = next.studySessions.find((s) => s.id === input.sessionId);
    if (!session) {
      throw new Error(`recordGradedAttempt: sessionId "${input.sessionId}" 不存在`);
    }
    if (session.status !== "in_progress") {
      throw new Error(`recordGradedAttempt: session "${input.sessionId}" 已經是 ${session.status}，不能再評分`);
    }

    // 第三輪修復（精準修復 1）：不能只信任呼叫端傳來的 learningItemId／ability／exerciseType，
    // 必須綁定 session 自己記錄的下一個 planned unit（由 exerciseResults.length 決定位置），
    // 否則呼叫端傳錯 item／ability／exerciseType 仍會被誤判為「這一題」而更新排程、item 狀態
    // 與 session，UI 保證不了正確性，這裡是最後一道防線。
    const expectedIndex = session.exerciseResults.length;
    const expectedUnit = session.plannedUnits[expectedIndex];
    if (!expectedUnit) {
      throw new Error(`recordGradedAttempt: session "${input.sessionId}" 已經沒有下一題可以評分`);
    }
    if (expectedUnit.learningItemId !== input.learningItemId) {
      throw new Error(
        `recordGradedAttempt: 這一題應該是 learningItemId "${expectedUnit.learningItemId}"，收到的是 "${input.learningItemId}"`
      );
    }
    if (expectedUnit.ability !== input.ability) {
      throw new Error(
        `recordGradedAttempt: 這一題應該是 ability "${expectedUnit.ability}"，收到的是 "${input.ability}"`
      );
    }
    if (input.exerciseType !== input.ability) {
      throw new Error(
        `recordGradedAttempt: exerciseType 必須符合 ability（recall→recall、reading→reading），收到 ability "${input.ability}" 搭配 exerciseType "${input.exerciseType}"`
      );
    }

    // 冪等防重：同一題（同一 exerciseId）在這個 session 已經有作答紀錄就拒絕，
    // 避免重複觸發（例如 UI 防護漏放）造成 duplicate attempt。
    const alreadyRecorded = next.reviewAttempts.some(
      (a) => a.sessionId === input.sessionId && a.exerciseId === input.exerciseId
    );
    if (alreadyRecorded) {
      throw new Error(`recordGradedAttempt: exerciseId "${input.exerciseId}" 在這個 session 已經評分過`);
    }

    const scheduleIndex = next.scheduleStates.findIndex(
      (s) => s.learningItemId === input.learningItemId && s.ability === input.ability
    );
    const previousPosition =
      scheduleIndex >= 0
        ? { streak: next.scheduleStates[scheduleIndex].streak, lapseCount: next.scheduleStates[scheduleIndex].lapseCount }
        : null;
    const computed = computeNextSchedule(previousPosition, input.result, input.now);

    const nextSchedule: ScheduleState = {
      learningItemId: input.learningItemId,
      ability: input.ability,
      language: item.language,
      dueAt: computed.dueAt,
      intervalDays: computed.intervalDays,
      streak: computed.streak,
      lapseCount: computed.lapseCount,
      lastReviewedAt: input.now.toISOString(),
    };
    if (scheduleIndex >= 0) {
      next.scheduleStates[scheduleIndex] = nextSchedule;
    } else {
      next.scheduleStates.push(nextSchedule);
    }

    // R1：整體 item status 要看這個項目「所有必要能力」的狀態合併結果，不能只看剛作答的這項。
    const abilityStatuses = requiredAbilities(item).map((ability) => {
      if (ability === input.ability) return computed.status;
      const other = next.scheduleStates.find((s) => s.learningItemId === item.id && s.ability === ability);
      return other ? deriveStatus(other.streak, other.lapseCount, true) : deriveStatus(0, 0, false);
    });
    const itemStatus = combineAbilityStatuses(abilityStatuses);
    item.status = itemStatus;

    const attempt: ReviewAttempt = {
      id: generateId("attempt"),
      exerciseId: input.exerciseId,
      learningItemId: input.learningItemId,
      language: item.language,
      exerciseType: input.exerciseType,
      sessionId: input.sessionId,
      result: input.result,
      usedHint: input.usedHint,
      responseTimeMs: input.responseTimeMs,
      reviewedAt: input.now.toISOString(),
    };
    next.reviewAttempts.push(attempt);

    session.exerciseResults.push({
      exerciseId: attempt.exerciseId,
      learningItemId: attempt.learningItemId,
      exerciseType: attempt.exerciseType,
      result: attempt.result,
      usedHint: attempt.usedHint,
      responseTimeMs: attempt.responseTimeMs,
    });

    // 最後一題完成才設定 completedAt，且跟這次評分同一次寫入，不會有「最後一題已存、
    // session 卻還沒標完成」的中間狀態。
    if (session.exerciseResults.length >= session.plannedUnits.length) {
      session.status = "completed";
      session.completedAt = input.now.toISOString();
    }

    this.commit(next);

    return {
      schedule: { ...nextSchedule },
      itemStatus,
      attempt: { ...attempt },
      session: this.cloneSession(session),
    };
  }

  // ---- 「我其實答對了」修正（原地改判，不新增第二筆 attempt） ----------------------

  markAttemptCorrect(input: MarkAttemptCorrectInput): RecordGradedAttemptResult {
    const next = this.cloneStore();

    const session = next.studySessions.find((s) => s.id === input.sessionId);
    if (!session) {
      throw new Error(`markAttemptCorrect: sessionId "${input.sessionId}" 不存在`);
    }

    // 只能修正「目前最後一筆作答」，也就是還沒有進到下一題——不看 session.status，
    // 因為最後一題評分的同一次寫入就會把 session 標成 completed，但那一題的修正窗口
    // （下一題之前）依然合法有效。
    const lastResult = session.exerciseResults[session.exerciseResults.length - 1];
    if (!lastResult || lastResult.exerciseId !== input.exerciseId) {
      throw new Error(
        `markAttemptCorrect: exerciseId "${input.exerciseId}" 不是 session "${input.sessionId}" 目前最後一題，已經無法修正`
      );
    }

    const attemptIndex = next.reviewAttempts.findIndex(
      (a) => a.sessionId === input.sessionId && a.exerciseId === input.exerciseId
    );
    if (attemptIndex < 0) {
      throw new Error(`markAttemptCorrect: 找不到 exerciseId "${input.exerciseId}" 對應的作答紀錄`);
    }
    const attempt = next.reviewAttempts[attemptIndex];

    const item = next.items.find((i) => i.id === attempt.learningItemId);
    if (!item) {
      throw new Error(`markAttemptCorrect: learningItemId "${attempt.learningItemId}" 不存在`);
    }

    const ability: AbilityKind = attempt.exerciseType === "reading" ? "reading" : "recall";

    // 冪等優先：這筆已經是 correct（例如重複點擊、或修正過一次後又被呼叫一次），不論
    // 之後有沒有更新的作答，都沒有任何東西需要改變——直接回傳「目前」的排程／狀態
    // （可能已經被更晚的作答推進過，如實回傳即可），不 clone-mutate-commit，避免「不可
    // 做不必要寫入」（即使底層 persistSnapshot 這次剛好會失敗，也不該讓一個沒有實際
    // 變更的呼叫因此拋錯）。這個分支不會動到任何資料，所以不受下面「不能讓排程倒退」
    // 的限制影響，也不需要先做那項檢查。
    if (attempt.result === "correct") {
      const currentSchedule = next.scheduleStates.find(
        (s) => s.learningItemId === attempt.learningItemId && s.ability === ability
      );
      if (!currentSchedule) {
        throw new Error(
          `markAttemptCorrect: learningItemId "${attempt.learningItemId}" 的 "${ability}" 排程狀態不存在，資料不一致`
        );
      }
      return {
        schedule: { ...currentSchedule },
        itemStatus: item.status,
        attempt: { ...attempt },
        session: this.cloneSession(session),
      };
    }

    // 精準修復（P1，GPT 獨立 review 發現）：completed session 永久保留，所以「這筆是不是
    // 它自己 session 裡的最後一題」（上面已經檢查過）不足以保證它是這個 (item, ability)
    // 全域最新的一筆——使用者可能在更晚的另一個 session B 已經對同一個 (item, ability)
    // 再次作答過（正常複習流程），這時候若還放行修正這個舊 session 的 attempt，下面的
    // 排程重算只會回放「這筆之前」的歷史＋這筆改成 correct，等於用一個更舊的排程直接
    // 覆寫掉 session B 之後累積的真正目前排程，讓 streak／dueAt 倒退、抹掉之後的學習
    // 進度。修法：只要這個 (item, ability) 在這筆之後（不分哪個 session）還有任何一筆
    // 更新的 attempt，一律拒絕修正、store 完全不變（不 commit）。這比「重放這筆之後全部
    // 歷史」更安全、更容易驗證正確；使用者的修正視窗本來就設計成「下一題之前」，正常
    // 操作永遠不會觸發這個限制，只有繞過 UI 或跨分頁使用舊 session 參照時才會擋下來。
    const hasNewerAttemptForSameAbility = next.reviewAttempts.some(
      (a, idx) => idx > attemptIndex && a.learningItemId === attempt.learningItemId && a.exerciseType === attempt.exerciseType
    );
    if (hasNewerAttemptForSameAbility) {
      throw new Error(
        `markAttemptCorrect: learningItemId "${attempt.learningItemId}" 的 "${ability}" 能力在這筆之後已經有更新的作答紀錄，修正會讓目前排程倒退，已拒絕`
      );
    }

    // 重新推導排程：把這個 (item, ability) 在這筆之前的作答序列（按寫入順序，也就是
    // 時間順序）重新跑一遍 computeNextSchedule 得到「這筆發生前」的 streak／lapseCount，
    // 再用「correct」而不是原本的結果算一次——這樣結果會跟「當初就直接答對」完全一致，
    // 不是在錯誤已經套用的排程上再疊加一次修正。
    const priorAttempts = next.reviewAttempts.filter(
      (a, idx) => idx < attemptIndex && a.learningItemId === attempt.learningItemId && a.exerciseType === attempt.exerciseType
    );
    let position: SchedulePosition | null = null;
    for (const prior of priorAttempts) {
      position = computeNextSchedule(position, prior.result, new Date(prior.reviewedAt));
    }
    const computed = computeNextSchedule(position, "correct", new Date(attempt.reviewedAt));

    const nextSchedule: ScheduleState = {
      learningItemId: attempt.learningItemId,
      ability,
      language: item.language,
      dueAt: computed.dueAt,
      intervalDays: computed.intervalDays,
      streak: computed.streak,
      lapseCount: computed.lapseCount,
      lastReviewedAt: attempt.reviewedAt,
    };
    const scheduleIndex = next.scheduleStates.findIndex(
      (s) => s.learningItemId === attempt.learningItemId && s.ability === ability
    );
    if (scheduleIndex >= 0) {
      next.scheduleStates[scheduleIndex] = nextSchedule;
    } else {
      next.scheduleStates.push(nextSchedule);
    }

    const abilityStatuses = requiredAbilities(item).map((a) => {
      if (a === ability) return computed.status;
      const other = next.scheduleStates.find((s) => s.learningItemId === item.id && s.ability === a);
      return other ? deriveStatus(other.streak, other.lapseCount, true) : deriveStatus(0, 0, false);
    });
    const itemStatus = combineAbilityStatuses(abilityStatuses);
    item.status = itemStatus;

    const updatedAttempt: ReviewAttempt = { ...attempt, result: "correct" };
    next.reviewAttempts[attemptIndex] = updatedAttempt;

    session.exerciseResults[session.exerciseResults.length - 1] = { ...lastResult, result: "correct" };

    this.commit(next);

    return {
      schedule: { ...nextSchedule },
      itemStatus,
      attempt: { ...updatedAttempt },
      session: this.cloneSession(session),
    };
  }
}

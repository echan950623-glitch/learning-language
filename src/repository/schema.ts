/**
 * 版本化本機資料格式 + 執行期驗證。
 *
 * 目的：
 * 1. schema 之後要調整時，靠 schemaVersion 判斷並可加 migration，不會直接讀壞資料。
 * 2. 讀到不明格式（使用者手動改過 localStorage、瀏覽器擴充干擾、未來版本降級等）
 *    要能安全 fallback，不讓整個 App 壞掉，而不是丟出例外讓頁面白屏。
 *
 * 驗證策略是「逐筆過濾」而不是「整包丟棄」：只要 schemaVersion 對得上，
 * 個別壞掉的紀錄會被濾掉並回報數量，其餘乾淨資料仍會保留。
 *
 * 2026-09-14 repair batch（R2）升級到 schemaVersion 2：
 * - 所有日期欄位改成嚴格驗證合法 ISO 字串（不是只檢查非空字串）——`dueAt: "abc"`
 *   這種值在 v1 只檢查非空字串就會通過，之後在 `isDueBy()` 變成 `NaN`，項目因此
 *   「已有 schedule 但永遠不會到期」而從學習佇列消失。
 * - 數字欄位驗證合理範圍與整數性（intervalDays > 0、streak/lapseCount/responseTimeMs
 *   為非負整數）。
 * - ScheduleState 改成 (learningItemId, ability) 一組一筆（見 domain/types.ts），
 *   對應 R1 的多能力 mastery。
 * - StudySession 新增 status／plannedUnits，對應 R3 的中途重整恢復。
 * - sanitize 後新增跨紀錄關聯清理：ScheduleState／ReviewAttempt 必須對應到存在且語言
 *   一致的 LearningItem，否則整筆丟棄（但不影響其他合法紀錄，LearningItem 本身也不會
 *   因為它的 schedule 壞掉而被牽連刪除——它只是安全地回到「沒有排程、可重新當新內容」
 *   的狀態）。
 * - 缺少必要陣列（不是陣列、或欄位不存在）視為 fallback 訊號，不會被靜默當成合法空陣列。
 * - 有 v1 → v2 migration，合法 v1 資料會被保留並轉換，不會整包丟棄。
 */

import type {
  AbilityKind,
  AttemptResult,
  ExerciseType,
  ItemSource,
  ItemStatus,
  ItemType,
  Language,
  LearningItem,
  ReviewAttempt,
  ScheduleState,
  StudySession,
  StudySessionExerciseResult,
  StudySessionPlannedUnit,
  StudySessionStatus,
} from "../domain/types";

export const STORAGE_KEY = "learning-language:store";
export const SCHEMA_VERSION = 2 as const;

export interface PersistedStore {
  schemaVersion: 2;
  items: LearningItem[];
  scheduleStates: ScheduleState[];
  reviewAttempts: ReviewAttempt[];
  studySessions: StudySession[];
}

export function createEmptyStore(): PersistedStore {
  return { schemaVersion: SCHEMA_VERSION, items: [], scheduleStates: [], reviewAttempts: [], studySessions: [] };
}

const LANGUAGES: Language[] = ["ja", "en"];
const ITEM_TYPES: ItemType[] = ["vocabulary", "grammar", "phrase", "collocation"];
const ITEM_SOURCES: ItemSource[] = ["ai", "textbook", "teacher", "song", "manual"];
const ITEM_STATUSES: ItemStatus[] = ["new", "learning", "mastered", "struggling"];
const EXERCISE_TYPES: ExerciseType[] = ["recall", "reading", "spelling", "translation"];
const ABILITY_KINDS: AbilityKind[] = ["recall", "reading"];
const ATTEMPT_RESULTS: AttemptResult[] = ["correct", "partial", "incorrect"];
const SESSION_STATUSES: StudySessionStatus[] = ["in_progress", "completed", "abandoned"];
const PLANNED_UNIT_KINDS: Array<StudySessionPlannedUnit["kind"]> = ["review", "new"];

// 我們自己所有寫入都經過 `.toISOString()`，格式固定為
// YYYY-MM-DDTHH:mm:ss(.sss)?Z；用這個格式驗證可以擋掉「abc」「2026/09/14」這類
// Date.parse 可能寬鬆接受、但不是我們自己會產生的格式。
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * 驗證字串不只是「格式像 ISO」，還要是**真實存在**的日期／時間。
 *
 * `new Date("2026-02-31T00:00:00.000Z")` 這種格式合法、但日期不存在的字串，在部分 JS
 * 引擎會被靜默正規化成 3 月的某一天（而不是回傳 Invalid Date），單靠格式 regex + NaN
 * 檢查會誤判為合法。這裡額外把 Date 解析後的 UTC 年／月／日／時／分／秒／毫秒讀回來，
 * 跟輸入逐項比對；只要有一項不一致，就代表原始輸入其實是不存在的日期（例如 2 月 31 日、
 * 非閏年的 2 月 29 日），必須拒絕。合法的閏年 2 月 29 日（例如 2024、2028 年）不受影響。
 */
function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_REGEX.exec(value);
  if (!match) return false;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, msStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  // 分數秒代表「秒的小數部分」，"5" 是 0.5 秒＝500ms，跟 Date 解析毫秒的語意一致。
  const millisecond = msStr ? Number(msStr.padEnd(3, "0")) : 0;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === millisecond
  );
}

function isOptionalIsoDateString(value: unknown): value is string | undefined {
  return value === undefined || isIsoDateString(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isLearningItem(value: unknown): value is LearningItem {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    LANGUAGES.includes(value.language as Language) &&
    ITEM_TYPES.includes(value.type as ItemType) &&
    isNonEmptyString(value.promptZh) &&
    isNonEmptyString(value.answer) &&
    isOptionalString(value.reading) &&
    isOptionalString(value.explanation) &&
    ITEM_SOURCES.includes(value.source as ItemSource) &&
    isStringArray(value.tags) &&
    ITEM_STATUSES.includes(value.status as ItemStatus) &&
    isIsoDateString(value.createdAt) &&
    isBoolean(value.isSeed)
  );
}

export function isScheduleState(value: unknown): value is ScheduleState {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.learningItemId) &&
    ABILITY_KINDS.includes(value.ability as AbilityKind) &&
    LANGUAGES.includes(value.language as Language) &&
    isIsoDateString(value.dueAt) &&
    isPositiveInt(value.intervalDays) &&
    isNonNegativeInt(value.streak) &&
    isNonNegativeInt(value.lapseCount) &&
    isOptionalIsoDateString(value.lastReviewedAt)
  );
}

function isStudySessionExerciseResult(value: unknown): value is StudySessionExerciseResult {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.exerciseId) &&
    isNonEmptyString(value.learningItemId) &&
    EXERCISE_TYPES.includes(value.exerciseType as ExerciseType) &&
    ATTEMPT_RESULTS.includes(value.result as AttemptResult) &&
    isBoolean(value.usedHint) &&
    isNonNegativeInt(value.responseTimeMs)
  );
}

function isStudySessionPlannedUnit(value: unknown): value is StudySessionPlannedUnit {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.learningItemId) &&
    ABILITY_KINDS.includes(value.ability as AbilityKind) &&
    PLANNED_UNIT_KINDS.includes(value.kind as StudySessionPlannedUnit["kind"])
  );
}

export function isReviewAttempt(value: unknown): value is ReviewAttempt {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.exerciseId) &&
    isNonEmptyString(value.learningItemId) &&
    LANGUAGES.includes(value.language as Language) &&
    EXERCISE_TYPES.includes(value.exerciseType as ExerciseType) &&
    isNonEmptyString(value.sessionId) &&
    ATTEMPT_RESULTS.includes(value.result as AttemptResult) &&
    isBoolean(value.usedHint) &&
    isNonNegativeInt(value.responseTimeMs) &&
    isIsoDateString(value.reviewedAt)
  );
}

/**
 * 除了欄位形狀，還驗證 StudySession 內部的一致性（第三輪修復 R2）：
 * - `exerciseResults` 不能比 `plannedUnits` 還長。
 * - 每一筆 `exerciseResults[i]` 必須對應同一位置 `plannedUnits[i]` 的 `learningItemId`，
 *   且 `exerciseType` 必須符合該位置規劃的 `ability`（recall→recall、reading→reading）。
 * - `in_progress`：不能有 `completedAt`，且必須還有下一題（`exerciseResults.length <
 *   plannedUnits.length`）——沒有下一題卻還標 in_progress，代表資料損毀，不是合法狀態。
 * - `completed`：必須有 `completedAt`，且題目必須全部做完（不能還有下一題）。
 * - `abandoned`：跟 in_progress 一樣不能有 `completedAt`；`abandonSession` 只會作用在
 *   in_progress 上、凍結當時的進度，所以合法的 abandoned session 也必然還有「原本的
 *   下一題」（否則早就在那次作答時被標成 completed 了，不會有機會被放棄）。
 *
 * 這裡只檢查 session 自身內部的資料是否自洽；「in_progress 的 plannedUnits 是否引用
 * 存在且語言一致的 LearningItem」需要 items 清單才能判斷，屬於跨紀錄關聯清理，
 * 在 `finalizeStore` 處理（completed／abandoned 的歷史紀錄允許引用已刪除的項目）。
 */
export function isStudySession(value: unknown): value is StudySession {
  if (!isRecord(value)) return false;
  if (
    !(
      isNonEmptyString(value.id) &&
      LANGUAGES.includes(value.language as Language) &&
      SESSION_STATUSES.includes(value.status as StudySessionStatus) &&
      isIsoDateString(value.startedAt) &&
      isOptionalIsoDateString(value.completedAt) &&
      Array.isArray(value.plannedUnits) &&
      (value.plannedUnits as unknown[]).every(isStudySessionPlannedUnit) &&
      Array.isArray(value.exerciseResults) &&
      (value.exerciseResults as unknown[]).every(isStudySessionExerciseResult) &&
      isStringArray(value.newItemIds) &&
      isStringArray(value.reviewItemIds)
    )
  ) {
    return false;
  }

  const plannedUnits = value.plannedUnits as StudySessionPlannedUnit[];
  const exerciseResults = value.exerciseResults as StudySessionExerciseResult[];
  const status = value.status as StudySessionStatus;
  const completedAt = value.completedAt as string | undefined;

  if (exerciseResults.length > plannedUnits.length) return false;

  for (let i = 0; i < exerciseResults.length; i += 1) {
    const unit = plannedUnits[i];
    const result = exerciseResults[i];
    if (result.learningItemId !== unit.learningItemId) return false;
    if (result.exerciseType !== unit.ability) return false;
  }

  const hasNextUnit = exerciseResults.length < plannedUnits.length;

  if (status === "completed") {
    return completedAt !== undefined && !hasNextUnit;
  }
  // in_progress／abandoned：都不該有 completedAt，且都必然還有下一題可做
  // （abandoned 是從 in_progress 凍結來的，凍結那一刻必然還沒做完）。
  return completedAt === undefined && hasNextUnit;
}

// ---------------------------------------------------------------------------
// v1（schemaVersion 1）舊格式的結構驗證，只用於 migration 路徑。
// LearningItem／ReviewAttempt 的形狀在 v1／v2 之間沒有變化，直接重用上面的 guard。
// ScheduleState／StudySession 的形狀變了，v1 版本沒有 ability／status／plannedUnits。
// ---------------------------------------------------------------------------

interface LegacyScheduleStateV1 {
  learningItemId: string;
  language: Language;
  dueAt: string;
  intervalDays: number;
  streak: number;
  lapseCount: number;
  lastReviewedAt?: string;
}

function isLegacyScheduleStateV1(value: unknown): value is LegacyScheduleStateV1 {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.learningItemId) &&
    LANGUAGES.includes(value.language as Language) &&
    isIsoDateString(value.dueAt) &&
    isPositiveInt(value.intervalDays) &&
    isNonNegativeInt(value.streak) &&
    isNonNegativeInt(value.lapseCount) &&
    isOptionalIsoDateString(value.lastReviewedAt)
  );
}

interface LegacyStudySessionV1 {
  id: string;
  language: Language;
  startedAt: string;
  completedAt?: string;
  exerciseResults: StudySessionExerciseResult[];
  newItemIds: string[];
  reviewItemIds: string[];
}

function isLegacyStudySessionV1(value: unknown): value is LegacyStudySessionV1 {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    LANGUAGES.includes(value.language as Language) &&
    isIsoDateString(value.startedAt) &&
    isOptionalIsoDateString(value.completedAt) &&
    Array.isArray(value.exerciseResults) &&
    (value.exerciseResults as unknown[]).every(isStudySessionExerciseResult) &&
    isStringArray(value.newItemIds) &&
    isStringArray(value.reviewItemIds)
  );
}

function toAbilityKind(exerciseType: ExerciseType): AbilityKind {
  return exerciseType === "reading" ? "reading" : "recall";
}

/** v1 的 ScheduleState 沒有能力分工，一律當成該項目「recall」能力的既有進度；reading 從零開始。 */
function migrateScheduleStateV1ToV2(legacy: LegacyScheduleStateV1): ScheduleState {
  return {
    learningItemId: legacy.learningItemId,
    ability: "recall",
    language: legacy.language,
    dueAt: legacy.dueAt,
    intervalDays: legacy.intervalDays,
    streak: legacy.streak,
    lapseCount: legacy.lapseCount,
    lastReviewedAt: legacy.lastReviewedAt,
  };
}

/** v1 的 StudySession 只在完成時才會被存下來，所以一律是 completed；plannedUnits 從既有作答紀錄反推。 */
function migrateStudySessionV1ToV2(legacy: LegacyStudySessionV1): StudySession {
  return {
    id: legacy.id,
    language: legacy.language,
    status: "completed",
    startedAt: legacy.startedAt,
    completedAt: legacy.completedAt ?? legacy.startedAt,
    plannedUnits: legacy.exerciseResults.map((r) => ({
      learningItemId: r.learningItemId,
      ability: toAbilityKind(r.exerciseType),
      kind: legacy.newItemIds.includes(r.learningItemId) ? "new" : "review",
    })),
    exerciseResults: legacy.exerciseResults,
    newItemIds: legacy.newItemIds,
    reviewItemIds: legacy.reviewItemIds,
  };
}

// ---------------------------------------------------------------------------
// sanitize 主流程
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  store: PersistedStore;
  droppedCounts: {
    items: number;
    scheduleStates: number;
    reviewAttempts: number;
    studySessions: number;
  };
  /** 哪些集合原始資料不是陣列（缺少必要陣列），這種情況本身就算 usedFallback。 */
  missingArrays: string[];
  usedFallback: boolean;
}

interface FilterOutcome<T> {
  valid: T[];
  dropped: number;
  missingArray: boolean;
}

function filterValid<T>(list: unknown, guard: (v: unknown) => v is T): FilterOutcome<T> {
  if (!Array.isArray(list)) {
    return { valid: [], dropped: 0, missingArray: true };
  }
  const valid = list.filter(guard);
  return { valid, dropped: list.length - valid.length, missingArray: false };
}

/**
 * 跨紀錄關聯清理（v2 直讀與 v1 migration 都會經過這一關）：
 * - ScheduleState／ReviewAttempt 必須對應到存在、且語言一致的 LearningItem，否則丟棄；
 *   LearningItem 本身完全不受影響（它只是失去這筆排程／作答紀錄，安全回到可重新排程的狀態）。
 * - ScheduleState 依 (learningItemId, ability) 去重，只留第一筆，避免壞資料造成重複鍵。
 * - StudySession：completed／abandoned 不強制要求 plannedUnits／exerciseResults 引用的項目
 *   仍存在（歷史紀錄本來就可能引用之後被使用者移除的項目），只依 id 去重；但 in_progress
 *   的 plannedUnits 必須全部引用存在且語言一致的 LearningItem，否則整個 session 丟棄——
 *   一個引用不到項目的 in_progress session 沒辦法被 /study 正常恢復，留著只會卡住畫面，
 *   丟棄後 `/study` 會自然當成沒有進行中的 session、重新建立一個新的。
 */
function finalizeStore(
  items: LearningItem[],
  scheduleStates: ScheduleState[],
  reviewAttempts: ReviewAttempt[],
  studySessions: StudySession[]
): { store: PersistedStore; crossRefDropped: { scheduleStates: number; reviewAttempts: number; studySessions: number } } {
  const itemById = new Map(items.map((item) => [item.id, item]));

  const seenScheduleKeys = new Set<string>();
  let scheduleCrossRefDropped = 0;
  const validSchedules: ScheduleState[] = [];
  for (const schedule of scheduleStates) {
    const item = itemById.get(schedule.learningItemId);
    if (!item || item.language !== schedule.language) {
      scheduleCrossRefDropped += 1;
      continue;
    }
    const key = `${schedule.learningItemId}:${schedule.ability}`;
    if (seenScheduleKeys.has(key)) {
      scheduleCrossRefDropped += 1;
      continue;
    }
    seenScheduleKeys.add(key);
    validSchedules.push(schedule);
  }

  let attemptCrossRefDropped = 0;
  const validAttempts: ReviewAttempt[] = [];
  for (const attempt of reviewAttempts) {
    const item = itemById.get(attempt.learningItemId);
    if (!item || item.language !== attempt.language) {
      attemptCrossRefDropped += 1;
      continue;
    }
    validAttempts.push(attempt);
  }

  const seenSessionIds = new Set<string>();
  let sessionCrossRefDropped = 0;
  const validSessions: StudySession[] = [];
  for (const session of studySessions) {
    if (seenSessionIds.has(session.id)) {
      sessionCrossRefDropped += 1;
      continue;
    }

    if (session.status === "in_progress") {
      const allUnitsReferenceRealItems = session.plannedUnits.every((unit) => {
        const item = itemById.get(unit.learningItemId);
        return item !== undefined && item.language === session.language;
      });
      if (!allUnitsReferenceRealItems) {
        sessionCrossRefDropped += 1;
        continue;
      }
    }

    seenSessionIds.add(session.id);
    validSessions.push(session);
  }

  return {
    store: {
      schemaVersion: SCHEMA_VERSION,
      items,
      scheduleStates: validSchedules,
      reviewAttempts: validAttempts,
      studySessions: validSessions,
    },
    crossRefDropped: {
      scheduleStates: scheduleCrossRefDropped,
      reviewAttempts: attemptCrossRefDropped,
      studySessions: sessionCrossRefDropped,
    },
  };
}

function sanitizeV2Shape(raw: Record<string, unknown>): SanitizeResult {
  const itemsResult = filterValid(raw.items, isLearningItem);
  const scheduleResult = filterValid(raw.scheduleStates, isScheduleState);
  const attemptsResult = filterValid(raw.reviewAttempts, isReviewAttempt);
  const sessionsResult = filterValid(raw.studySessions, isStudySession);

  const { store, crossRefDropped } = finalizeStore(
    itemsResult.valid,
    scheduleResult.valid,
    attemptsResult.valid,
    sessionsResult.valid
  );

  const missingArrays = [
    itemsResult.missingArray ? "items" : null,
    scheduleResult.missingArray ? "scheduleStates" : null,
    attemptsResult.missingArray ? "reviewAttempts" : null,
    sessionsResult.missingArray ? "studySessions" : null,
  ].filter((v): v is string => v !== null);

  const droppedCounts = {
    items: itemsResult.dropped,
    scheduleStates: scheduleResult.dropped + crossRefDropped.scheduleStates,
    reviewAttempts: attemptsResult.dropped + crossRefDropped.reviewAttempts,
    studySessions: sessionsResult.dropped + crossRefDropped.studySessions,
  };

  const usedFallback = missingArrays.length > 0 || Object.values(droppedCounts).some((n) => n > 0);

  return { store, droppedCounts, missingArrays, usedFallback };
}

function migrateV1Shape(raw: Record<string, unknown>): SanitizeResult {
  const itemsResult = filterValid(raw.items, isLearningItem);
  const legacyScheduleResult = filterValid(raw.scheduleStates, isLegacyScheduleStateV1);
  const attemptsResult = filterValid(raw.reviewAttempts, isReviewAttempt);
  const legacySessionResult = filterValid(raw.studySessions, isLegacyStudySessionV1);

  const migratedSchedules = legacyScheduleResult.valid.map(migrateScheduleStateV1ToV2);
  const migratedSessions = legacySessionResult.valid.map(migrateStudySessionV1ToV2);

  const { store, crossRefDropped } = finalizeStore(
    itemsResult.valid,
    migratedSchedules,
    attemptsResult.valid,
    migratedSessions
  );

  const missingArrays = [
    itemsResult.missingArray ? "items" : null,
    legacyScheduleResult.missingArray ? "scheduleStates" : null,
    attemptsResult.missingArray ? "reviewAttempts" : null,
    legacySessionResult.missingArray ? "studySessions" : null,
  ].filter((v): v is string => v !== null);

  const droppedCounts = {
    items: itemsResult.dropped,
    scheduleStates: legacyScheduleResult.dropped + crossRefDropped.scheduleStates,
    reviewAttempts: attemptsResult.dropped + crossRefDropped.reviewAttempts,
    studySessions: legacySessionResult.dropped + crossRefDropped.studySessions,
  };

  // migration 本身不算 fallback（這是預期的版本升級路徑）；只有實際有東西被濾掉才算。
  const usedFallback = missingArrays.length > 0 || Object.values(droppedCounts).some((n) => n > 0);

  return { store, droppedCounts, missingArrays, usedFallback };
}

/**
 * 把任意 unknown（通常來自 JSON.parse(localStorage 內容)）轉成安全的 PersistedStore（v2）。
 * - schemaVersion 2：照 v2 規則逐筆驗證＋跨紀錄清理。
 * - schemaVersion 1：先用 v1 規則驗證，再 migrate 成 v2 形狀，不會整包丟棄合法舊資料。
 * - 其他（不是物件、缺 schemaVersion、未來版本）：安全回退為空 store，不嘗試臆測轉換。
 */
export function sanitizeStore(raw: unknown): SanitizeResult {
  if (!isRecord(raw)) {
    return {
      store: createEmptyStore(),
      droppedCounts: { items: 0, scheduleStates: 0, reviewAttempts: 0, studySessions: 0 },
      missingArrays: [],
      usedFallback: true,
    };
  }

  if (raw.schemaVersion === SCHEMA_VERSION) {
    return sanitizeV2Shape(raw);
  }

  if (raw.schemaVersion === 1) {
    return migrateV1Shape(raw);
  }

  return {
    store: createEmptyStore(),
    droppedCounts: { items: 0, scheduleStates: 0, reviewAttempts: 0, studySessions: 0 },
    missingArrays: [],
    usedFallback: true,
  };
}

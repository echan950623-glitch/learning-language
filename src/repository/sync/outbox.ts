/**
 * 離線優先同步的核心資料結構：outbox（待送佇列）。
 *
 * 見 ARCHITECTURE.md「雲端化架構」的「Outbox 操作型別與對應的 Supabase 呼叫」與
 * 「資料表」兩節——這裡的型別是那份凍結合約的 TypeScript 化身，欄位命名（snake_case）
 * 刻意跟 Postgres 資料表欄位一致，因為這些物件會直接當成 `.upsert()`／`.rpc()` 的參數送出，
 * 不需要在送出前再轉換一次。
 *
 * 持久化：獨立 localStorage key（跟主要的 `learning-language:store` 完全分開）。任何
 * 讀取、解析或寫入失敗都會 fail closed；不能把未知的待送資料當成空佇列而繼續同步。
 * 主要 PersistedStore 仍是獨立 key，因此錯誤不會刪除本機學習資料。
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
  StudySessionPlannedUnit,
  StudySessionStatus,
} from "../../domain/types";
import { generateId } from "../../domain/id";
import { nowIso } from "../../domain/time";

export const OUTBOX_STORAGE_KEY = "learning-language:sync-outbox";

// ---------------------------------------------------------------------------
// Supabase 資料表 row／RPC payload 型別（見 ARCHITECTURE.md「資料表」「RPC」兩節）
// ---------------------------------------------------------------------------

export interface LearningItemRow {
  id: string;
  user_id: string;
  language: Language;
  type: ItemType;
  prompt_zh: string;
  answer: string;
  reading: string | null;
  explanation: string | null;
  romaji: string | null;
  part_of_speech: string | null;
  example_sentence: string | null;
  source: ItemSource;
  tags: string[];
  status: ItemStatus;
  created_at: string;
  is_seed: boolean;
}

export interface ScheduleStateRow {
  user_id: string;
  learning_item_id: string;
  ability: AbilityKind;
  language: Language;
  due_at: string;
  interval_days: number;
  streak: number;
  lapse_count: number;
  last_reviewed_at: string | null;
}

export interface StudySessionRow {
  id: string;
  user_id: string;
  language: Language;
  status: StudySessionStatus;
  started_at: string;
  completed_at: string | null;
  planned_units: StudySessionPlannedUnit[];
  new_item_ids: string[];
  review_item_ids: string[];
}

/** `review_attempts` 的 guarded migration RPC payload；一般作答走評分／修正 RPC。 */
export interface ReviewAttemptRow {
  id: string;
  user_id: string;
  session_id: string;
  sequence_in_session: number;
  exercise_id: string;
  learning_item_id: string;
  language: Language;
  exercise_type: ExerciseType;
  result: AttemptResult;
  used_hint: boolean;
  response_time_ms: number;
  reviewed_at: string;
}

export interface UserPreferencesRow {
  user_id: string;
  daily_question_count: number;
  daily_new_item_cap: number;
}

export interface RecordGradedAttemptRpcInput {
  /** 本機先建立的穩定 ID；伺服器必須使用同一個 ID，讓重送可逐欄核對。 */
  attempt_id: string;
  session_id: string;
  learning_item_id: string;
  ability: AbilityKind;
  exercise_id: string;
  exercise_type: ExerciseType;
  result: AttemptResult;
  used_hint: boolean;
  response_time_ms: number;
  reviewed_at: string;
  /** 作答前看到的排程；null 表示當時尚未有這個能力的排程。伺服器以此做 CAS。 */
  expected_schedule: ExpectedScheduleState | null;
  schedule: {
    due_at: string;
    interval_days: number;
    streak: number;
    lapse_count: number;
  };
  item_status: ItemStatus;
  session_completed: boolean;
  session_completed_at: string | null;
}

export interface MarkAttemptCorrectRpcInput {
  session_id: string;
  exercise_id: string;
  /** 修正前看到的排程，伺服器以此做 CAS，拒絕覆蓋其他裝置較新的進度。 */
  expected_schedule: ExpectedScheduleState;
  schedule: {
    due_at: string;
    interval_days: number;
    streak: number;
    lapse_count: number;
  };
  item_status: ItemStatus;
}

export interface ExpectedScheduleState {
  due_at: string;
  interval_days: number;
  streak: number;
  lapse_count: number;
  last_reviewed_at: string | null;
}

// ---------------------------------------------------------------------------
// Outbox 操作型別
// ---------------------------------------------------------------------------

export type OutboxOperation =
  | { type: "upsert_item"; payload: LearningItemRow } // guarded RPC
  | { type: "delete_items"; payload: { ids: string[] } } // guarded RPC
  | { type: "upsert_schedule_state"; payload: ScheduleStateRow } // guarded RPC；僅 migration／初始匯入
  | { type: "upsert_session"; payload: StudySessionRow } // guarded RPC（建立／恢復 in_progress）
  | { type: "abandon_session"; payload: { sessionId: string } } // guarded RPC
  | { type: "record_graded_attempt"; payload: RecordGradedAttemptRpcInput } // .rpc('record_graded_attempt', {payload})
  | { type: "mark_attempt_correct"; payload: MarkAttemptCorrectRpcInput } // .rpc('mark_attempt_correct', {payload})
  | { type: "upsert_preferences"; payload: UserPreferencesRow } // guarded RPC
  | { type: "upsert_review_attempt"; payload: ReviewAttemptRow }; // guarded RPC；僅 migration

export type OutboxOperationType = OutboxOperation["type"];

export type OutboxEntry = OutboxOperation & {
  id: string;
  /** ISO 時間字串，enqueue 當下的時間，不代表實際送達伺服器的時間。 */
  createdAt: string;
  /** 已經嘗試送出但失敗的次數，用於除錯／未來可能的重試上限判斷。 */
  attempts: number;
  /** 最近一次失敗的人類可讀訊息（英文/系統層級即可，UI 顯示另外用中文包裝）。 */
  lastError?: string;
};

const OUTBOX_OPERATION_TYPES: readonly OutboxOperationType[] = [
  "upsert_item",
  "delete_items",
  "upsert_schedule_state",
  "upsert_session",
  "abandon_session",
  "record_graded_attempt",
  "mark_attempt_correct",
  "upsert_preferences",
  "upsert_review_attempt",
];

// ---------------------------------------------------------------------------
// 本機 domain 物件 <-> Supabase row 互轉（camelCase <-> snake_case）
// ---------------------------------------------------------------------------

export function learningItemToRow(item: LearningItem, userId: string): LearningItemRow {
  return {
    id: item.id,
    user_id: userId,
    language: item.language,
    type: item.type,
    prompt_zh: item.promptZh,
    answer: item.answer,
    reading: item.reading ?? null,
    explanation: item.explanation ?? null,
    romaji: item.romaji ?? null,
    part_of_speech: item.partOfSpeech ?? null,
    example_sentence: item.exampleSentence ?? null,
    source: item.source,
    tags: [...item.tags],
    status: item.status,
    created_at: item.createdAt,
    is_seed: item.isSeed,
  };
}

export function rowToLearningItem(row: LearningItemRow): LearningItem {
  return {
    id: row.id,
    language: row.language,
    type: row.type,
    promptZh: row.prompt_zh,
    answer: row.answer,
    reading: row.reading ?? undefined,
    explanation: row.explanation ?? undefined,
    romaji: row.romaji ?? undefined,
    partOfSpeech: row.part_of_speech ?? undefined,
    exampleSentence: row.example_sentence ?? undefined,
    source: row.source,
    tags: Array.isArray(row.tags) ? [...row.tags] : [],
    status: row.status,
    createdAt: row.created_at,
    isSeed: row.is_seed,
  };
}

export function scheduleStateToRow(schedule: ScheduleState, userId: string): ScheduleStateRow {
  return {
    user_id: userId,
    learning_item_id: schedule.learningItemId,
    ability: schedule.ability,
    language: schedule.language,
    due_at: schedule.dueAt,
    interval_days: schedule.intervalDays,
    streak: schedule.streak,
    lapse_count: schedule.lapseCount,
    last_reviewed_at: schedule.lastReviewedAt ?? null,
  };
}

export function rowToScheduleState(row: ScheduleStateRow): ScheduleState {
  return {
    learningItemId: row.learning_item_id,
    ability: row.ability,
    language: row.language,
    dueAt: row.due_at,
    intervalDays: row.interval_days,
    streak: row.streak,
    lapseCount: row.lapse_count,
    lastReviewedAt: row.last_reviewed_at ?? undefined,
  };
}

export function studySessionToRow(session: StudySession, userId: string): StudySessionRow {
  return {
    id: session.id,
    user_id: userId,
    language: session.language,
    status: session.status,
    started_at: session.startedAt,
    completed_at: session.completedAt ?? null,
    planned_units: session.plannedUnits.map((unit) => ({ ...unit })),
    new_item_ids: [...session.newItemIds],
    review_item_ids: [...session.reviewItemIds],
  };
}

/**
 * row -> StudySession：pull-merge 專用。刻意不還原 `exerciseResults`（`study_sessions`
 * 沒有存這個欄位，正規化拆進 `review_attempts`，見 ARCHITECTURE.md）；呼叫端要自行從
 * 已經合併好的 `review_attempts` 依 `sequence_in_session` 重建，這裡只負責 session 本身
 * 的欄位轉換，避免這個函式背負超出它名字的責任。
 */
export function rowToStudySessionShell(row: StudySessionRow): Omit<StudySession, "exerciseResults"> {
  return {
    id: row.id,
    language: row.language,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    plannedUnits: Array.isArray(row.planned_units) ? row.planned_units.map((unit) => ({ ...unit })) : [],
    newItemIds: Array.isArray(row.new_item_ids) ? [...row.new_item_ids] : [],
    reviewItemIds: Array.isArray(row.review_item_ids) ? [...row.review_item_ids] : [],
  };
}

/** migration 專用：把一筆本機 ReviewAttempt 直接轉成可以 upsert 進 review_attempts 的 row。 */
export function reviewAttemptToRow(attempt: ReviewAttempt, sequenceInSession: number, userId: string): ReviewAttemptRow {
  return {
    id: attempt.id,
    user_id: userId,
    session_id: attempt.sessionId,
    sequence_in_session: sequenceInSession,
    exercise_id: attempt.exerciseId,
    learning_item_id: attempt.learningItemId,
    language: attempt.language,
    exercise_type: attempt.exerciseType,
    result: attempt.result,
    used_hint: attempt.usedHint,
    response_time_ms: attempt.responseTimeMs,
    reviewed_at: attempt.reviewedAt,
  };
}

/** pull-merge 專用：遠端 review_attempts row 直接還原成本機 ReviewAttempt（沿用遠端 id）。 */
export function rowToReviewAttempt(row: ReviewAttemptRow): ReviewAttempt {
  return {
    id: row.id,
    exerciseId: row.exercise_id,
    learningItemId: row.learning_item_id,
    language: row.language,
    exerciseType: row.exercise_type,
    sessionId: row.session_id,
    result: row.result,
    usedHint: row.used_hint,
    responseTimeMs: row.response_time_ms,
    reviewedAt: row.reviewed_at,
  };
}

export function preferencesToRow(
  preferences: { dailyQuestionCount: number; dailyNewItemCap: number },
  userId: string
): UserPreferencesRow {
  return {
    user_id: userId,
    daily_question_count: preferences.dailyQuestionCount,
    daily_new_item_cap: preferences.dailyNewItemCap,
  };
}

// ---------------------------------------------------------------------------
// localStorage 讀寫 + 輕量 sanitize
// ---------------------------------------------------------------------------

export class OutboxPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutboxPersistenceError";
  }
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch (error) {
    throw new OutboxPersistenceError("目前無法使用本機儲存，已停止同步以保留待送資料", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 輕量驗證：只檢查 outbox entry 的「信封」欄位（id／type／payload 存在且形狀正確／
 * createdAt／attempts），不深入驗證每種 payload 內部欄位——那是 enqueue 當下已經保證好
 * 的形狀，這裡的 sanitize 只需要防禦「外部造成的毀損」（手動改過 localStorage、
 * 瀏覽器擴充干擾等），比照 schema.ts 的精神但刻意輕量。
 */
function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.type === "string" &&
    OUTBOX_OPERATION_TYPES.includes(value.type as OutboxOperationType) &&
    isRecord(value.payload) &&
    typeof value.createdAt === "string" &&
    typeof value.attempts === "number" &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 0 &&
    (value.lastError === undefined || typeof value.lastError === "string")
  );
}

function readOutboxEntries(): OutboxEntry[] {
  const storage = browserStorage();
  if (!storage) return [];

  let raw: string | null;
  try {
    raw = storage.getItem(OUTBOX_STORAGE_KEY);
  } catch (error) {
    throw new OutboxPersistenceError("讀取同步佇列失敗，已停止同步以保留待送資料", { cause: error });
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new OutboxPersistenceError("同步佇列不是合法 JSON，已停止同步以保留待送資料", { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new OutboxPersistenceError("同步佇列格式損毀，已停止同步以保留待送資料");
  }

  if (!parsed.every(isOutboxEntry)) {
    throw new OutboxPersistenceError("同步佇列含有格式不正確的項目，已停止同步以保留待送資料");
  }
  return parsed;
}

/** 真的執行 localStorage 寫入；瀏覽器端任何失敗都必須回報，不能假裝已 enqueue。 */
function persistOutboxEntries(entries: OutboxEntry[]): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    throw new OutboxPersistenceError("寫入同步佇列失敗，本機資料仍保留但尚未排入雲端同步", { cause: error });
  }
}

function writeOutboxEntries(entries: OutboxEntry[]): void {
  persistOutboxEntries(entries);
}

// ---------------------------------------------------------------------------
// 對外 API
// ---------------------------------------------------------------------------

/** 依 enqueue 順序（等同插入順序）回傳目前所有待送項目，最舊的在前面。 */
export function listOutboxEntries(): OutboxEntry[] {
  return readOutboxEntries();
}

export function outboxPendingCount(): number {
  return readOutboxEntries().length;
}

export function enqueueOutboxEntry(operation: OutboxOperation): OutboxEntry {
  const entry: OutboxEntry = {
    ...operation,
    id: generateId("outbox"),
    createdAt: nowIso(),
    attempts: 0,
  };
  const entries = readOutboxEntries();
  entries.push(entry);
  writeOutboxEntries(entries);
  return entry;
}

/** 偏好是每個帳戶各一份可變設定；同帳戶尚未送出的舊值沒有歷史語意，只保留最後一次選擇。 */
export function enqueueLatestPreferences(payload: UserPreferencesRow): OutboxEntry {
  const entry: OutboxEntry = {
    type: "upsert_preferences",
    payload,
    id: generateId("outbox"),
    createdAt: nowIso(),
    attempts: 0,
  };
  const entries: OutboxEntry[] = readOutboxEntries().filter(
    (candidate): boolean => candidate.type !== "upsert_preferences" || candidate.payload.user_id !== payload.user_id
  );
  entries.push(entry);
  writeOutboxEntries(entries);
  return entry;
}

/** 批次 enqueue，單一次讀寫（migration 大量匯入用，避免每筆都各自讀寫一次 localStorage）。 */
export function enqueueOutboxEntries(operations: OutboxOperation[]): OutboxEntry[] {
  if (operations.length === 0) return [];
  const newEntries: OutboxEntry[] = operations.map((operation) => ({
    ...operation,
    id: generateId("outbox"),
    createdAt: nowIso(),
    attempts: 0,
  }));
  const entries = readOutboxEntries();
  entries.push(...newEntries);
  writeOutboxEntries(entries);
  return newEntries;
}

/**
 * 整批覆寫 outbox（單一次 localStorage 寫入）。目前只有 content-key 衝突的 remap 流程
 * （syncEngine.ts 的 `resolveContentKeyConflict`）使用——需要「移除已經解決的那筆＋改寫
 * 其餘所有引用同一個 learningItemId 的操作」在同一次寫入內完成，讓中斷／重試維持一致
 * （半套的話，下一次 drain 到同一筆時會用同樣的輸入重新算一次，結果不變，見該函式註解）。
 *
 * 這一步失敗代表「衝突其實還沒解決」，呼叫端必須知道並把它當成一般失敗處理。
 */
export function setOutboxEntries(entries: OutboxEntry[]): void {
  persistOutboxEntries(entries);
}

export function removeOutboxEntry(id: string): void {
  const entries = readOutboxEntries();
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return;
  writeOutboxEntries(next);
}

export function markOutboxEntryFailed(id: string, message: string): void {
  const entries = readOutboxEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  entries[index] = { ...entries[index], attempts: entries[index].attempts + 1, lastError: message };
  writeOutboxEntries(entries);
}

/** 只給測試使用：清空 outbox，避免測試之間互相汙染。 */
export function __clearOutboxForTests(): void {
  writeOutboxEntries([]);
}

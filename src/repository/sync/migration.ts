/**
 * 一次性 localStorage v2 → Supabase migration。見 ARCHITECTURE.md「一次性 migration」節：
 * 重用 outbox（不另寫一套送出機制）——批次組出跟正常操作一樣形狀的 outbox operation，
 * 一次 enqueue，然後 await 同一個 `drainOutboxFully` 送完，過程中回報進度。
 *
 * 這裡刻意「只讀」`LearningRepository` 的公開介面（`listItems`／`listScheduleStates`／
 * `listReviewAttempts`／`listStudySessions({status:'all'})`），不去碰
 * `LocalStorageLearningRepository` 的任何內部狀態——這四個讀取方法已經足夠重建一份完整的
 * `PersistedStore` 形狀（備份用）與逐筆 enqueue 所需的所有欄位，不需要也不應該為了
 * migration 給那幾個凍結的 class 開後門。
 */

import type { LearningRepository } from "../types";
import { readPersistedStore, SCHEMA_VERSION, type PersistedStore } from "../schema";
import { readSyncablePreferences } from "../../lib/studyPreferences";
import {
  enqueueOutboxEntries,
  learningItemToRow,
  outboxPendingCount,
  preferencesToRow,
  reviewAttemptToRow,
  scheduleStateToRow,
  studySessionToRow,
  type LearningItemRow,
  type OutboxOperation,
  type ReviewAttemptRow,
  type ScheduleStateRow,
  type StudySessionRow,
} from "./outbox";
import { drainOutboxFully } from "./syncEngine";
import { loadAliasStore, resolveCanonicalItemId } from "./alias";

import type { SupabaseClient } from "@supabase/supabase-js";

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function migrationCompletedKey(userId: string): string {
  return `learning-language:migration-completed:${userId}`;
}

const BACKUP_KEY_PREFIX = "learning-language:store:pre-migration-backup:";

export function isMigrationCompleted(userId: string): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    return storage.getItem(migrationCompletedKey(userId)) === "true";
  } catch {
    return false;
  }
}

function markMigrationCompleted(userId: string): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(migrationCompletedKey(userId), "true");
  } catch (error) {
    console.warn("[learning-language] 標記遷移完成狀態失敗（不影響已經同步上去的資料）", error);
  }
}

/** 只新增、不覆蓋、永不自動刪除——每次真的執行 migration（含重試）都會留下一份新快照。 */
function backupLocalStore(store: PersistedStore): void {
  const storage = browserStorage();
  if (!storage) throw new Error("無法使用本機儲存，未建立遷移前備份，因此已停止同步。");
  try {
    storage.setItem(`${BACKUP_KEY_PREFIX}${Date.now()}`, JSON.stringify(store));
  } catch (error) {
    throw new Error("遷移前備份本機資料失敗，因此已停止同步。", { cause: error });
  }
}

// ---------------------------------------------------------------------------
// 狀態（供 MigrationPanel 訂閱）
// ---------------------------------------------------------------------------

export type MigrationPhase = "unknown" | "not_needed" | "running" | "completed" | "partial_failure" | "error";

export interface MigrationCategoryResult {
  key: "items" | "scheduleStates" | "reviewAttempts" | "studySessions" | "preferences";
  label: string;
  localCount: number;
  remoteCount: number;
  ok: boolean;
  /** `ok` 是 false 時，實際核對失敗的本機識別碼（items/reviewAttempts/studySessions 是 id，scheduleStates 是 `learningItemId:ability`）。只給除錯／測試使用，UI 目前不顯示。 */
  mismatchedIds?: string[];
}

export interface MigrationStatus {
  phase: MigrationPhase;
  progress?: { completed: number; total: number };
  categories?: MigrationCategoryResult[];
  message?: string;
}

type MigrationStatusListener = (status: MigrationStatus) => void;

let currentStatus: MigrationStatus = { phase: "unknown" };
const listeners = new Set<MigrationStatusListener>();

function setStatus(next: MigrationStatus): void {
  currentStatus = next;
  for (const listener of listeners) listener(currentStatus);
}

export function getMigrationStatus(): MigrationStatus {
  return currentStatus;
}

export function subscribeMigrationStatus(listener: MigrationStatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// 核對：drain 完成後，逐筆核對 migration 開始前建立的 immutable manifest
// 是否都能在遠端找到對應紀錄，而不是只比較兩邊的總筆數——總筆數相等（甚至遠端更多）
// 不代表每一筆本機紀錄都真的落地，也不代表關聯（review_attempts.learning_item_id、
// study_sessions.planned_units 引用的項目）沒有在 canonical id 轉換後留下斷鏈。
// ---------------------------------------------------------------------------

interface RemoteSnapshot {
  items: LearningItemRow[];
  scheduleStates: ScheduleStateRow[];
  reviewAttempts: ReviewAttemptRow[];
  studySessions: StudySessionRow[];
  preferences: Array<{ user_id: string; daily_question_count: number; daily_new_item_cap: number }>;
}

async function fetchRemoteSnapshot(supabase: SupabaseClient, userId: string): Promise<RemoteSnapshot> {
  const [itemsRes, scheduleRes, attemptsRes, sessionsRes, preferencesRes] = await Promise.all([
    supabase.from("learning_items").select("*").eq("user_id", userId),
    supabase.from("schedule_states").select("*").eq("user_id", userId),
    supabase.from("review_attempts").select("*").eq("user_id", userId),
    supabase.from("study_sessions").select("*").eq("user_id", userId),
    supabase.from("user_preferences").select("*").eq("user_id", userId),
  ]);
  if (itemsRes.error) throw new Error(itemsRes.error.message);
  if (scheduleRes.error) throw new Error(scheduleRes.error.message);
  if (attemptsRes.error) throw new Error(attemptsRes.error.message);
  if (sessionsRes.error) throw new Error(sessionsRes.error.message);
  if (preferencesRes.error) throw new Error(preferencesRes.error.message);

  return {
    items: (itemsRes.data ?? []) as LearningItemRow[],
    scheduleStates: (scheduleRes.data ?? []) as ScheduleStateRow[],
    reviewAttempts: (attemptsRes.data ?? []) as ReviewAttemptRow[],
    studySessions: (sessionsRes.data ?? []) as StudySessionRow[],
    preferences: (preferencesRes.data ?? []) as RemoteSnapshot["preferences"],
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)])
  );
}

/** JSONB 不保留物件鍵順序；陣列順序仍有語意，物件鍵順序則沒有。 */
export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function checkItems(local: PersistedStore["items"], remote: LearningItemRow[], userId: string): MigrationCategoryResult {
  const aliases = loadAliasStore(userId);
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const mismatchedIds = local.filter((item) => {
    const expected = learningItemToRow(item, userId);
    const canonicalId = resolveCanonicalItemId(aliases, item.id);
    const row = remoteById.get(canonicalId);
    if (!row) return true;
    const scalarKeys: Array<keyof LearningItemRow> = ["user_id", "language", "type", "prompt_zh", "answer", "reading", "explanation", "romaji", "part_of_speech", "example_sentence", "source", "status", "is_seed"];
    if (scalarKeys.some((key) => row[key] !== expected[key])) return true;
    if (!expected.tags.every((tag) => row.tags.includes(tag))) return true;
    // 沒有別名代表這筆是以原始 ID 新增，created_at 也必須一致；別名則保留 canonical 紀錄原始建立時間。
    return canonicalId === item.id && row.created_at !== expected.created_at;
  }).map((item) => item.id);
  return {
    key: "items",
    label: "學習項目",
    localCount: local.length,
    remoteCount: remote.length,
    ok: mismatchedIds.length === 0,
    mismatchedIds: mismatchedIds.length > 0 ? mismatchedIds : undefined,
  };
}

function checkScheduleStates(
  local: PersistedStore["scheduleStates"],
  remote: ScheduleStateRow[],
  userId: string
): MigrationCategoryResult {
  const aliases = loadAliasStore(userId);
  const remoteByKey = new Map(remote.map((row) => [`${row.learning_item_id}:${row.ability}`, row]));
  const mismatchedIds = local
    .filter((schedule) => {
      const expected = scheduleStateToRow(schedule, userId);
      expected.learning_item_id = resolveCanonicalItemId(aliases, expected.learning_item_id);
      const row = remoteByKey.get(`${expected.learning_item_id}:${expected.ability}`);
      return !row || !sameJson(
        { user_id: row.user_id, learning_item_id: row.learning_item_id, ability: row.ability, language: row.language, due_at: row.due_at, interval_days: row.interval_days, streak: row.streak, lapse_count: row.lapse_count, last_reviewed_at: row.last_reviewed_at },
        expected
      );
    })
    .map((schedule) => `${schedule.learningItemId}:${schedule.ability}`);
  return {
    key: "scheduleStates",
    label: "排程狀態",
    localCount: local.length,
    remoteCount: remote.length,
    ok: mismatchedIds.length === 0,
    mismatchedIds: mismatchedIds.length > 0 ? mismatchedIds : undefined,
  };
}

/** 不只檢查 id 存在，還要 learning_item_id／session_id 都跟 immutable manifest 一致，避免斷鏈。 */
function checkReviewAttempts(
  local: PersistedStore["reviewAttempts"],
  remote: ReviewAttemptRow[],
  sessions: PersistedStore["studySessions"],
  userId: string
): MigrationCategoryResult {
  const aliases = loadAliasStore(userId);
  const mismatchedIds = local
    .filter((attempt) => {
      const session = sessions.find((candidate) => candidate.id === attempt.sessionId);
      const sequence = session?.exerciseResults.findIndex((result) => result.exerciseId === attempt.exerciseId) ?? -1;
      if (sequence < 0) return true;
      const expected = reviewAttemptToRow(attempt, sequence, userId);
      expected.learning_item_id = resolveCanonicalItemId(aliases, expected.learning_item_id);
      const row = remote.find((candidate) => candidate.id === attempt.id || (candidate.session_id === attempt.sessionId && candidate.exercise_id === attempt.exerciseId));
      if (!row) return true;
      return !sameJson(
        { id: row.id, user_id: row.user_id, session_id: row.session_id, sequence_in_session: row.sequence_in_session, exercise_id: row.exercise_id, learning_item_id: row.learning_item_id, language: row.language, exercise_type: row.exercise_type, result: row.result, used_hint: row.used_hint, response_time_ms: row.response_time_ms, reviewed_at: row.reviewed_at },
        expected
      );
    })
    .map((attempt) => attempt.id);
  return {
    key: "reviewAttempts",
    label: "作答紀錄",
    localCount: local.length,
    remoteCount: remote.length,
    ok: mismatchedIds.length === 0,
    mismatchedIds: mismatchedIds.length > 0 ? mismatchedIds : undefined,
  };
}

/** 除了 session 本身存在，plannedUnits 引用的每個 learningItemId 也必須是遠端真的存在的項目。 */
function checkStudySessions(
  local: PersistedStore["studySessions"],
  remote: StudySessionRow[],
  remoteItemIds: Set<string>,
  userId: string
): MigrationCategoryResult {
  const aliases = loadAliasStore(userId);
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const mismatchedIds = local
    .filter((session) => {
      const row = remoteById.get(session.id);
      if (!row) return true;
      const expected = studySessionToRow(session, userId);
      expected.planned_units = expected.planned_units.map((unit) => ({ ...unit, learningItemId: resolveCanonicalItemId(aliases, unit.learningItemId) }));
      expected.new_item_ids = expected.new_item_ids.map((id) => resolveCanonicalItemId(aliases, id));
      expected.review_item_ids = expected.review_item_ids.map((id) => resolveCanonicalItemId(aliases, id));
      if (!expected.planned_units.every((unit) => remoteItemIds.has(unit.learningItemId))) return true;
      return !sameJson(
        { id: row.id, user_id: row.user_id, language: row.language, status: row.status, started_at: row.started_at, completed_at: row.completed_at, planned_units: row.planned_units, new_item_ids: row.new_item_ids, review_item_ids: row.review_item_ids },
        expected
      );
    })
    .map((session) => session.id);
  return {
    key: "studySessions",
    label: "學習 session",
    localCount: local.length,
    remoteCount: remote.length,
    ok: mismatchedIds.length === 0,
    mismatchedIds: mismatchedIds.length > 0 ? mismatchedIds : undefined,
  };
}

/** 以 migration 開始前的 immutable manifest 為準，並透過持久化 alias 解析遠端 canonical id。 */
async function verifyMigration(
  supabase: SupabaseClient,
  userId: string,
  manifest: PersistedStore = readPersistedStore(),
  expectedPreferences = readSyncablePreferences()
): Promise<MigrationCategoryResult[]> {
  const remote = await fetchRemoteSnapshot(supabase, userId);
  const preference = remote.preferences.find((row) => row.user_id === userId);
  const preferencesOk = !!preference && preference.daily_question_count === expectedPreferences.dailyQuestionCount && preference.daily_new_item_cap === expectedPreferences.dailyNewItemCap;

  return [
    checkItems(manifest.items, remote.items, userId),
    checkScheduleStates(manifest.scheduleStates, remote.scheduleStates, userId),
    checkReviewAttempts(manifest.reviewAttempts, remote.reviewAttempts, manifest.studySessions, userId),
    checkStudySessions(manifest.studySessions, remote.studySessions, new Set(remote.items.map((row) => row.id)), userId),
    { key: "preferences", label: "偏好設定", localCount: 1, remoteCount: remote.preferences.length, ok: preferencesOk, mismatchedIds: preferencesOk ? undefined : [userId] },
  ];
}

// ---------------------------------------------------------------------------
// runInitialMigration
// ---------------------------------------------------------------------------

export interface MigrationDeps {
  repository: LearningRepository;
  supabase: SupabaseClient;
  userId: string;
}

let isRunning = false;

/**
 * 冪等、可安全重試：偵測 → 備份 → 批次 enqueue → await 完整 drain → 核對 → 標記完成。
 * 任何一步之後重新呼叫都不會產生重複或壞資料（全部是 upsert／on-conflict），這正是
 * 「處理部分匯入」的完整答案，不需要另外設計「從哪裡繼續」的邏輯（見 ARCHITECTURE.md）。
 */
export async function runInitialMigration(deps: MigrationDeps): Promise<MigrationStatus> {
  if (isRunning) return currentStatus;
  isRunning = true;

  try {
    if (isMigrationCompleted(deps.userId)) {
      setStatus({ phase: "not_needed" });
      return currentStatus;
    }

    const items = deps.repository.listItems();
    const scheduleStates = deps.repository.listScheduleStates();
    const reviewAttempts = deps.repository.listReviewAttempts();
    const studySessions = deps.repository.listStudySessions({ status: "all" });
    const preferences = readSyncablePreferences();

    const hasAnyLocalData =
      items.length > 0 || scheduleStates.length > 0 || reviewAttempts.length > 0 || studySessions.length > 0;

    if (!hasAnyLocalData) {
      // 沒有本機資料可遷移（例如全新使用者）：直接標記完成，避免每次登入都重新檢查一次。
      markMigrationCompleted(deps.userId);
      setStatus({ phase: "not_needed" });
      return currentStatus;
    }

    const manifest: PersistedStore = {
      schemaVersion: SCHEMA_VERSION,
      items,
      scheduleStates,
      reviewAttempts,
      studySessions,
    };
    backupLocalStore(manifest);

    // 批次 enqueue：items → sessions → attempts → scheduleStates。attempts 的 FK
    // 需要前兩者先存在；schedule 最後經 guarded RPC 寫入，遇到另一端已存在且不同就保留衝突。
    // attempts 依「全域插入順序」
    // （`listReviewAttempts()` 保留 this.store.reviewAttempts 的原始順序，也就是實際發生的
    // 時間順序，見 baseRepository.ts）逐筆算出 sequence_in_session 後 enqueue，讓 drain
    // 嚴格依序寫入時 review_attempts.seq（identity 欄位）保留正確的相對順序。
    const operations: OutboxOperation[] = [];
    for (const item of items) {
      operations.push({ type: "upsert_item", payload: learningItemToRow(item, deps.userId) });
    }
    for (const session of studySessions) {
      operations.push({ type: "upsert_session", payload: studySessionToRow(session, deps.userId) });
    }
    const sessionById = new Map(studySessions.map((session) => [session.id, session]));
    for (const attempt of reviewAttempts) {
      const session = sessionById.get(attempt.sessionId);
      const sequenceInSession = session
        ? session.exerciseResults.findIndex((result) => result.exerciseId === attempt.exerciseId)
        : -1;
      if (!session || sequenceInSession < 0) {
        throw new Error(`作答紀錄 ${attempt.id} 無法對應原始 session/exercise，已保留資料並停止遷移。`);
      }
      operations.push({
        type: "upsert_review_attempt",
        payload: reviewAttemptToRow(attempt, sequenceInSession, deps.userId),
      });
    }
    for (const schedule of scheduleStates) {
      operations.push({ type: "upsert_schedule_state", payload: scheduleStateToRow(schedule, deps.userId) });
    }
    operations.push({ type: "upsert_preferences", payload: preferencesToRow(preferences, deps.userId) });

    enqueueOutboxEntries(operations);
    const total = operations.length;
    setStatus({ phase: "running", progress: { completed: 0, total } });

    const drainResult = await drainOutboxFully(
      deps.supabase,
      (pending) => {
        setStatus({ phase: "running", progress: { completed: Math.max(0, total - pending), total } });
      },
      deps.userId
    );

    if (!drainResult.success) {
      setStatus({
        phase: "partial_failure",
        progress: { completed: Math.max(0, total - outboxPendingCount()), total },
        message: drainResult.message ?? "同步過程中發生錯誤，部分資料尚未上傳，可以直接重試（安全、不會重複）。",
      });
      return currentStatus;
    }

    const categories = await verifyMigration(deps.supabase, deps.userId, manifest, preferences);

    const allPassed = categories.every((category) => category.ok);
    if (allPassed) {
      markMigrationCompleted(deps.userId);
      setStatus({ phase: "completed", categories });
    } else {
      setStatus({
        phase: "partial_failure",
        categories,
        message: "核對後發現部分資料尚未同步完成，可以直接重試（安全、不會重複）。",
      });
    }
    return currentStatus;
  } catch (error) {
    setStatus({
      phase: "error",
      message: error instanceof Error ? error.message : "遷移過程發生未預期的錯誤，請稍後重試。",
    });
    return currentStatus;
  } finally {
    isRunning = false;
  }
}

/** 只給測試使用：重置模組層級狀態，避免測試之間互相汙染。 */
export function __resetMigrationForTests(): void {
  isRunning = false;
  currentStatus = { phase: "unknown" };
  listeners.clear();
}

/** 只給測試使用：直接測試「逐筆核對關聯」而不用整趟跑 runInitialMigration。 */
export const __verifyMigrationForTests = verifyMigration;

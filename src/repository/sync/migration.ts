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
import { SCHEMA_VERSION, type PersistedStore } from "../schema";
import { readSyncablePreferences } from "../../lib/studyPreferences";
import {
  enqueueOutboxEntries,
  learningItemToRow,
  outboxPendingCount,
  preferencesToRow,
  reviewAttemptToRow,
  scheduleStateToRow,
  studySessionToRow,
  type OutboxOperation,
} from "./outbox";
import { drainOutboxFully } from "./syncEngine";

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
  if (!storage) return;
  try {
    storage.setItem(`${BACKUP_KEY_PREFIX}${Date.now()}`, JSON.stringify(store));
  } catch (error) {
    console.warn("[learning-language] 遷移前備份本機資料失敗（不影響遷移本身繼續進行）", error);
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
// 核對：drain 完成後，遠端各表筆數是否 >= 本機筆數
// ---------------------------------------------------------------------------

interface LocalCounts {
  items: number;
  scheduleStates: number;
  reviewAttempts: number;
  studySessions: number;
}

async function countRemoteRows(supabase: SupabaseClient, table: string, userId: string): Promise<number> {
  const response = await supabase.from(table).select("*", { count: "exact", head: true }).eq("user_id", userId);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.count ?? 0;
}

async function verifyMigration(
  supabase: SupabaseClient,
  userId: string,
  local: LocalCounts
): Promise<MigrationCategoryResult[]> {
  const [items, scheduleStates, reviewAttempts, studySessions, preferences] = await Promise.all([
    countRemoteRows(supabase, "learning_items", userId),
    countRemoteRows(supabase, "schedule_states", userId),
    countRemoteRows(supabase, "review_attempts", userId),
    countRemoteRows(supabase, "study_sessions", userId),
    countRemoteRows(supabase, "user_preferences", userId),
  ]);

  return [
    { key: "items", label: "學習項目", localCount: local.items, remoteCount: items, ok: items >= local.items },
    {
      key: "scheduleStates",
      label: "排程狀態",
      localCount: local.scheduleStates,
      remoteCount: scheduleStates,
      ok: scheduleStates >= local.scheduleStates,
    },
    {
      key: "reviewAttempts",
      label: "作答紀錄",
      localCount: local.reviewAttempts,
      remoteCount: reviewAttempts,
      ok: reviewAttempts >= local.reviewAttempts,
    },
    {
      key: "studySessions",
      label: "學習 session",
      localCount: local.studySessions,
      remoteCount: studySessions,
      ok: studySessions >= local.studySessions,
    },
    // 偏好設定沒有「本機筆數」的概念（永遠是目前生效的那一份），遠端只要存在一筆就算通過。
    { key: "preferences", label: "偏好設定", localCount: 1, remoteCount: preferences, ok: preferences >= 1 },
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

    backupLocalStore({
      schemaVersion: SCHEMA_VERSION,
      items,
      scheduleStates,
      reviewAttempts,
      studySessions,
    });

    // 批次 enqueue：items → sessions → scheduleStates 先進去（review_attempts 的 FK
    // 參照 learning_items／study_sessions，必須先存在），attempts 依「全域插入順序」
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
    for (const schedule of scheduleStates) {
      operations.push({ type: "upsert_schedule_state", payload: scheduleStateToRow(schedule, deps.userId) });
    }

    const sessionById = new Map(studySessions.map((session) => [session.id, session]));
    let skippedAttempts = 0;
    for (const attempt of reviewAttempts) {
      const session = sessionById.get(attempt.sessionId);
      const sequenceInSession = session
        ? session.exerciseResults.findIndex((result) => result.exerciseId === attempt.exerciseId)
        : -1;
      if (!session || sequenceInSession < 0) {
        // 理論上不會發生（attempt 必然對應它所屬 session 的 exerciseResults 其中一筆）；
        // 防禦性略過，避免單一筆不一致的歷史資料卡住整個 migration。
        skippedAttempts += 1;
        continue;
      }
      operations.push({
        type: "upsert_review_attempt",
        payload: reviewAttemptToRow(attempt, sequenceInSession, deps.userId),
      });
    }
    if (skippedAttempts > 0) {
      console.warn("[learning-language] 遷移時發現無法對應 session 的作答紀錄，已略過", { skippedAttempts });
    }

    operations.push({ type: "upsert_preferences", payload: preferencesToRow(preferences, deps.userId) });

    enqueueOutboxEntries(operations);
    const total = operations.length;
    setStatus({ phase: "running", progress: { completed: 0, total } });

    const drainResult = await drainOutboxFully(deps.supabase, (pending) => {
      setStatus({ phase: "running", progress: { completed: Math.max(0, total - pending), total } });
    });

    if (!drainResult.success) {
      setStatus({
        phase: "partial_failure",
        progress: { completed: Math.max(0, total - outboxPendingCount()), total },
        message: drainResult.message ?? "同步過程中發生錯誤，部分資料尚未上傳，可以直接重試（安全、不會重複）。",
      });
      return currentStatus;
    }

    const categories = await verifyMigration(deps.supabase, deps.userId, {
      items: items.length,
      scheduleStates: scheduleStates.length,
      reviewAttempts: reviewAttempts.length,
      studySessions: studySessions.length,
    });

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

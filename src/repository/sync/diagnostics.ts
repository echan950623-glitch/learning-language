/**
 * 同步診斷（唯讀）：把 outbox 目前的狀態整理成可以直接截圖回報的摘要。
 *
 * 只輸出操作類型、ID、排程數值與最近一次失敗訊息；不輸出單字內容、答案，也不碰任何憑證。
 * 純函式：輸入 outbox 條目、本機 store 與別名快照，不讀寫任何儲存，因此不會改變同步行為。
 */

import type { AbilityKind } from "../../domain/types";
import type { PersistedStore } from "../schema";
import { resolveCanonicalItemId, type AliasStoreSnapshot } from "./alias";
import type { ExpectedScheduleState, OutboxEntry, OutboxOperationType } from "./outbox";

export interface ScheduleSummary {
  dueAt: string;
  intervalDays: number;
  streak: number;
  lapseCount: number;
  lastReviewedAt: string | null;
}

export interface SyncHeadDiagnostics {
  type: OutboxOperationType;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  sessionId: string | null;
  exerciseId: string | null;
  /** 本機 ID；作答類操作可能與送到雲端的 canonical ID 不同（別名）。 */
  localItemId: string | null;
  canonicalItemId: string | null;
  ability: AbilityKind | null;
  /** 作答前呼叫端看到的排程；null 表示當時本機沒有這個能力的排程。 */
  expectedSchedule: ScheduleSummary | null;
  /** 這個項目／能力目前在本機 store 的排程；null 表示本機沒有。 */
  localSchedule: ScheduleSummary | null;
  localItemStatus: string | null;
}

export interface SyncDiagnostics {
  pendingCount: number;
  pendingByType: Partial<Record<OutboxOperationType, number>>;
  head: SyncHeadDiagnostics | null;
}

function fromExpected(expected: ExpectedScheduleState | null): ScheduleSummary | null {
  if (!expected) return null;
  return {
    dueAt: expected.due_at,
    intervalDays: expected.interval_days,
    streak: expected.streak,
    lapseCount: expected.lapse_count,
    lastReviewedAt: expected.last_reviewed_at,
  };
}

function describeHead(entry: OutboxEntry, store: PersistedStore, aliases: AliasStoreSnapshot | null): SyncHeadDiagnostics {
  let sessionId: string | null = null;
  let exerciseId: string | null = null;
  let localItemId: string | null = null;
  let ability: AbilityKind | null = null;
  let expected: ExpectedScheduleState | null = null;

  switch (entry.type) {
    case "record_graded_attempt":
      sessionId = entry.payload.session_id;
      exerciseId = entry.payload.exercise_id;
      localItemId = entry.payload.learning_item_id;
      ability = entry.payload.ability;
      expected = entry.payload.expected_schedule;
      break;
    case "mark_attempt_correct": {
      sessionId = entry.payload.session_id;
      exerciseId = entry.payload.exercise_id;
      expected = entry.payload.expected_schedule;
      const attempt = store.reviewAttempts.find(
        (candidate) => candidate.sessionId === sessionId && candidate.exerciseId === exerciseId
      );
      if (attempt) {
        localItemId = attempt.learningItemId;
        ability = attempt.exerciseType === "reading" ? "reading" : "recall";
      }
      break;
    }
    case "upsert_item":
      localItemId = entry.payload.id;
      break;
    case "upsert_schedule_state":
    case "upsert_review_attempt":
      localItemId = entry.payload.learning_item_id;
      break;
    case "upsert_session":
      sessionId = entry.payload.id;
      break;
    case "abandon_session":
      sessionId = entry.payload.sessionId;
      break;
    case "delete_items":
    case "upsert_preferences":
      break;
  }

  const localSchedule =
    localItemId && ability
      ? store.scheduleStates.find((schedule) => schedule.learningItemId === localItemId && schedule.ability === ability)
      : undefined;

  return {
    type: entry.type,
    createdAt: entry.createdAt,
    attempts: entry.attempts,
    lastError: entry.lastError ?? null,
    sessionId,
    exerciseId,
    localItemId,
    canonicalItemId: localItemId && aliases ? resolveCanonicalItemId(aliases, localItemId) : localItemId,
    ability,
    expectedSchedule: fromExpected(expected),
    localSchedule: localSchedule
      ? {
          dueAt: localSchedule.dueAt,
          intervalDays: localSchedule.intervalDays,
          streak: localSchedule.streak,
          lapseCount: localSchedule.lapseCount,
          lastReviewedAt: localSchedule.lastReviewedAt ?? null,
        }
      : null,
    localItemStatus: localItemId ? (store.items.find((item) => item.id === localItemId)?.status ?? null) : null,
  };
}

export function buildSyncDiagnostics(
  entries: OutboxEntry[],
  store: PersistedStore,
  aliases: AliasStoreSnapshot | null
): SyncDiagnostics {
  const pendingByType: Partial<Record<OutboxOperationType, number>> = {};
  for (const entry of entries) {
    pendingByType[entry.type] = (pendingByType[entry.type] ?? 0) + 1;
  }
  return {
    pendingCount: entries.length,
    pendingByType,
    head: entries.length > 0 ? describeHead(entries[0], store, aliases) : null,
  };
}

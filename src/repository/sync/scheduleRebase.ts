/**
 * 無損重放（dynamic rebase）：處理 outbox 首筆 `sync_conflict:schedule_changed` 的一個狹窄案例。
 *
 * 背景：本機空白副本（同內容不同 ID）已有可信的 canonical alias，但本機當時沒有雲端已有的
 * schedule，所以作答帶 `expected_schedule = null`（或建立在那個本機空白基準上的鏈），送出時撞上
 * 雲端既有排程。伺服器的 CAS 是正確的，不能放寬；這裡改成「送出當下」讀取雲端目前的排程，
 * 以它為基準用專案既有 SRS 函式重新計算，並以雲端目前排程當 expected_schedule 再呼叫原本的
 * guarded RPC。伺服器仍在鎖內重新核對，重放期間若雲端又變動就會被拒絕，本模組重讀重算。
 *
 * 安全前提（任何一項不成立都回傳 refused，outbox 原封不動、繼續 fail closed）：
 * 1. 本機 item 已有 canonical alias，且雙方內容欄位相容。
 * 2. 雲端 canonical item 與目前排程存在；雲端尚無同一 session_id + exercise_id 的作答
 *    （已存在時逐欄核對：完全相同視為冪等完成，不同則保留衝突）。
 * 3. 原始作答時間必須晚於雲端排程的 last_reviewed_at，不把舊作答倒放在新進度之上。
 * 4. 原始 expected_schedule 必須是 null（本機當時沒有這個能力的進度），或能由本模組先前寫下
 *    的重放 journal 證明「它就是同一條待送鏈上前一筆的本機結果」，且雲端目前排程仍等於
 *    那一筆重放後的結果——否則代表雙端各自有進度，不自動合併。
 *
 * 不變式：不修改、不刪除、不標記完成任何 outbox entry（呼叫端只在 RPC 成功後才移除）；
 * 送出前先把「原始 payload＋重放前後排程」寫入 append-only journal，寫入失敗就中止；
 * journal 讓「RPC 成功但本機來不及移除 entry」的重試能辨識為已完成，不重複作答。
 * used_hint 屬於作答紀錄本身，SRS `computeNextSchedule` 不以它為輸入，原樣保留在 payload。
 */

import { combineAbilityStatuses, computeNextSchedule, deriveStatus } from "../../domain/srs";
import { requiredAbilities } from "../../domain/abilities";
import { generateId } from "../../domain/id";
import { nowIso } from "../../domain/time";
import type { AbilityKind, ItemStatus } from "../../domain/types";
import { readPersistedStore } from "../schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkItemFieldsCompatible } from "./duplicateItemResolution";
import { loadAliasStore, translateOutgoingOperation, type AliasStoreSnapshot } from "./alias";
import {
  learningItemToRow,
  rowToLearningItem,
  type ExpectedScheduleState,
  type LearningItemRow,
  type MarkAttemptCorrectRpcInput,
  type OutboxEntry,
  type RecordGradedAttemptRpcInput,
  type ReviewAttemptRow,
  type ScheduleStateRow,
} from "./outbox";

export type RebaseRefusal =
  | "no_alias"
  | "alias_unreadable"
  | "journal_unreadable"
  | "journal_write_failed"
  | "local_item_missing"
  | "fields_incompatible"
  | "cloud_item_missing"
  | "cloud_schedule_missing"
  | "attempt_differs"
  | "attempt_missing_in_cloud"
  | "attempt_not_newer_than_cloud"
  | "unproven_expected_schedule"
  | "no_rebase_record_for_correction"
  | "correction_state_mismatch"
  | "cloud_schedule_changed_since_replay"
  | "cloud_schedule_kept_changing";

export type RebaseOutcome =
  | { kind: "applied" }
  | { kind: "already_applied" }
  | { kind: "proceed" }
  | { kind: "refused"; reason: RebaseRefusal }
  | { kind: "error"; status: number; message: string };

const MAX_ROUNDS = 3;
const JOURNAL_KEY_PREFIX = "learning-language:sync-rebase-journal:";

// ---------------------------------------------------------------------------
// 重放 journal（append-only、帳號範圍）
// ---------------------------------------------------------------------------

export interface RebaseJournalEntry {
  id: string;
  createdAt: string;
  kind: "record_graded_attempt" | "mark_attempt_correct";
  sessionId: string;
  exerciseId: string;
  outboxEntryId: string;
  canonicalItemId: string;
  ability: AbilityKind;
  /** 原始 payload 的 expected_schedule（本機作答前看到的排程）。 */
  localExpected: ExpectedScheduleState | null;
  /** 本機這次操作後自己算出的排程（後續操作的 expected_schedule 會等於它）。 */
  localAfter: ExpectedScheduleState;
  /** 重放前雲端排程。 */
  cloudBefore: ExpectedScheduleState;
  /** 重放成功後雲端應有的排程。 */
  cloudAfter: ExpectedScheduleState;
  /** 原始 outbox payload 的完整副本，供人工／未來流程復原。 */
  originalPayload: RecordGradedAttemptRpcInput | MarkAttemptCorrectRpcInput;
}

class RebaseJournalError extends Error {}

function journalStorage(): Storage {
  if (typeof window === "undefined") throw new RebaseJournalError("no window");
  try {
    return window.localStorage;
  } catch (error) {
    throw new RebaseJournalError("storage unavailable", { cause: error });
  }
}

function isSchedule(value: unknown): value is ExpectedScheduleState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.due_at === "string" &&
    typeof v.interval_days === "number" &&
    typeof v.streak === "number" &&
    typeof v.lapse_count === "number" &&
    (v.last_reviewed_at === null || typeof v.last_reviewed_at === "string")
  );
}

function isJournalEntry(value: unknown): value is RebaseJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.createdAt === "string" &&
    (v.kind === "record_graded_attempt" || v.kind === "mark_attempt_correct") &&
    typeof v.sessionId === "string" &&
    typeof v.exerciseId === "string" &&
    typeof v.outboxEntryId === "string" &&
    typeof v.canonicalItemId === "string" &&
    (v.ability === "recall" || v.ability === "reading") &&
    (v.localExpected === null || isSchedule(v.localExpected)) &&
    isSchedule(v.localAfter) &&
    isSchedule(v.cloudBefore) &&
    isSchedule(v.cloudAfter) &&
    typeof v.originalPayload === "object" &&
    v.originalPayload !== null
  );
}

/** 毀損就丟錯（fail closed），不回退成空 journal——空 journal 會讓後續操作失去鏈證明。 */
export function readRebaseJournal(userId: string): RebaseJournalEntry[] {
  const storage = journalStorage();
  let raw: string | null;
  try {
    raw = storage.getItem(`${JOURNAL_KEY_PREFIX}${userId}`);
  } catch (error) {
    throw new RebaseJournalError("read failed", { cause: error });
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isJournalEntry)) throw new RebaseJournalError("corrupt");
    return parsed;
  } catch (error) {
    if (error instanceof RebaseJournalError) throw error;
    throw new RebaseJournalError("not json", { cause: error });
  }
}

function appendRebaseJournal(userId: string, entry: RebaseJournalEntry): void {
  const storage = journalStorage();
  const next = [...readRebaseJournal(userId), entry];
  try {
    storage.setItem(`${JOURNAL_KEY_PREFIX}${userId}`, JSON.stringify(next));
  } catch (error) {
    throw new RebaseJournalError("write failed", { cause: error });
  }
}

/** 只給測試使用。 */
export function __clearRebaseJournalForTests(userId: string): void {
  try {
    journalStorage().removeItem(`${JOURNAL_KEY_PREFIX}${userId}`);
  } catch {
    // 測試環境沒有 storage 時忽略。
  }
}

// ---------------------------------------------------------------------------
// 排程比較／轉換
// ---------------------------------------------------------------------------

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return !Number.isNaN(left) && !Number.isNaN(right) && left === right;
}

function scheduleEquals(a: ExpectedScheduleState, b: ExpectedScheduleState): boolean {
  return (
    sameInstant(a.due_at, b.due_at) &&
    a.interval_days === b.interval_days &&
    a.streak === b.streak &&
    a.lapse_count === b.lapse_count &&
    sameInstant(a.last_reviewed_at, b.last_reviewed_at)
  );
}

function rowToSnapshot(row: ScheduleStateRow): ExpectedScheduleState {
  return {
    due_at: row.due_at,
    interval_days: row.interval_days,
    streak: row.streak,
    lapse_count: row.lapse_count,
    last_reviewed_at: row.last_reviewed_at,
  };
}

function abilityForExerciseType(exerciseType: string): AbilityKind {
  return exerciseType === "reading" ? "reading" : "recall";
}

// ---------------------------------------------------------------------------
// 雲端讀取
// ---------------------------------------------------------------------------

interface CloudSnapshot {
  item: LearningItemRow | null;
  schedule: ScheduleStateRow | null;
  schedules: ScheduleStateRow[];
  attempt: ReviewAttemptRow | null;
}

type CloudRead = { ok: true; value: CloudSnapshot } | { ok: false; status: number; message: string };

async function readCloud(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
  ability: AbilityKind,
  sessionId: string,
  exerciseId: string
): Promise<CloudRead> {
  const [itemRes, schedulesRes, attemptRes] = await Promise.all([
    supabase.from("learning_items").select("*").eq("user_id", userId).eq("id", itemId).maybeSingle(),
    supabase.from("schedule_states").select("*").eq("user_id", userId).eq("learning_item_id", itemId),
    supabase.from("review_attempts").select("*").eq("user_id", userId).eq("session_id", sessionId).eq("exercise_id", exerciseId).maybeSingle(),
  ]);
  for (const res of [itemRes, schedulesRes, attemptRes]) {
    if (res.error) return { ok: false, status: res.status ?? 0, message: res.error.message };
  }
  const schedules = (schedulesRes.data as ScheduleStateRow[] | null) ?? [];
  return {
    ok: true,
    value: {
      item: (itemRes.data as LearningItemRow | null) ?? null,
      schedule: schedules.find((row) => row.ability === ability) ?? null,
      schedules,
      attempt: (attemptRes.data as ReviewAttemptRow | null) ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 共用檢查與計算
// ---------------------------------------------------------------------------

function isScheduleChanged(error: { message: string } | null): boolean {
  return !!error && error.message.includes("sync_conflict:schedule_changed");
}

function safeAliases(userId: string): AliasStoreSnapshot | null {
  try {
    return loadAliasStore(userId);
  } catch {
    return null;
  }
}

function safeJournal(userId: string): RebaseJournalEntry[] | null {
  try {
    return readRebaseJournal(userId);
  } catch {
    return null;
  }
}

/** 內容欄位（content key）必須相同、其餘欄位相容；status 由作答推導，比較時以雲端為準。 */
function localItemCompatible(userId: string, localItemId: string, cloudItem: LearningItemRow): boolean {
  try {
    const localItem = readPersistedStore().items.find((item) => item.id === localItemId);
    if (!localItem) return false;
    const local = learningItemToRow(localItem, userId);
    const sameContent =
      local.language === cloudItem.language &&
      local.type === cloudItem.type &&
      local.prompt_zh === cloudItem.prompt_zh &&
      local.answer === cloudItem.answer &&
      (local.reading ?? null) === (cloudItem.reading ?? null);
    return sameContent && checkItemFieldsCompatible(cloudItem, { ...local, status: cloudItem.status }).compatible;
  } catch {
    return false;
  }
}

/** 以雲端排程重算整體 item 狀態：本次能力用新算出的狀態，其他能力沿用雲端排程。 */
function deriveItemStatus(
  cloudItem: LearningItemRow,
  schedules: ScheduleStateRow[],
  ability: AbilityKind,
  abilityStatus: ItemStatus
): ItemStatus {
  const item = rowToLearningItem(cloudItem);
  return combineAbilityStatuses(
    requiredAbilities(item).map((required) => {
      if (required === ability) return abilityStatus;
      const other = schedules.find((row) => row.ability === required);
      return other ? deriveStatus(other.streak, other.lapse_count, true) : deriveStatus(0, 0, false);
    })
  );
}

function sameAttempt(cloud: ReviewAttemptRow, payload: RecordGradedAttemptRpcInput): boolean {
  return (
    cloud.id === payload.attempt_id &&
    cloud.learning_item_id === payload.learning_item_id &&
    cloud.exercise_type === payload.exercise_type &&
    cloud.result === payload.result &&
    cloud.used_hint === payload.used_hint &&
    cloud.response_time_ms === payload.response_time_ms &&
    sameInstant(cloud.reviewed_at, payload.reviewed_at)
  );
}

/** 證明 expected 是同一條待送鏈上前一筆的本機結果，且雲端仍停在那一筆重放後的狀態。 */
function chainProven(
  journal: RebaseJournalEntry[],
  canonicalItemId: string,
  ability: AbilityKind,
  expected: ExpectedScheduleState,
  cloudSchedule: ExpectedScheduleState
): boolean {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry.canonicalItemId !== canonicalItemId || entry.ability !== ability) continue;
    return scheduleEquals(entry.localAfter, expected) && scheduleEquals(entry.cloudAfter, cloudSchedule);
  }
  return false;
}

function latestJournal(
  journal: RebaseJournalEntry[],
  kind: RebaseJournalEntry["kind"],
  sessionId: string,
  exerciseId: string
): RebaseJournalEntry | undefined {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry.kind === kind && entry.sessionId === sessionId && entry.exerciseId === exerciseId) return entry;
  }
  return undefined;
}

const refuse = (reason: RebaseRefusal): RebaseOutcome => ({ kind: "refused", reason });

// ---------------------------------------------------------------------------
// record_graded_attempt
// ---------------------------------------------------------------------------

async function rebaseRecord(
  supabase: SupabaseClient,
  userId: string,
  entry: OutboxEntry & { type: "record_graded_attempt" }
): Promise<RebaseOutcome> {
  const original = entry.payload;
  const aliases = safeAliases(userId);
  if (!aliases) return refuse("alias_unreadable");
  const alias = aliases.items.find((candidate) => candidate.localId === original.learning_item_id);
  if (!alias) return refuse("no_alias");
  const translated = translateOutgoingOperation(entry, aliases);
  if (translated.type !== "record_graded_attempt") return refuse("no_alias");
  const base = translated.payload;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const journal = safeJournal(userId);
    if (!journal) return refuse("journal_unreadable");
    const read = await readCloud(supabase, userId, alias.canonicalId, original.ability, original.session_id, original.exercise_id);
    if (!read.ok) return { kind: "error", status: read.status, message: read.message };
    const cloud = read.value;

    if (!cloud.item) return refuse("cloud_item_missing");
    if (cloud.attempt) return sameAttempt(cloud.attempt, base) ? { kind: "already_applied" } : refuse("attempt_differs");
    if (!cloud.schedule) return refuse("cloud_schedule_missing");
    if (!localItemCompatible(userId, original.learning_item_id, cloud.item)) return refuse("fields_incompatible");

    const cloudSchedule = rowToSnapshot(cloud.schedule);
    if (original.expected_schedule !== null) {
      if (!chainProven(journal, alias.canonicalId, original.ability, original.expected_schedule, cloudSchedule)) {
        return refuse("unproven_expected_schedule");
      }
    }
    if (cloudSchedule.last_reviewed_at !== null && !(Date.parse(original.reviewed_at) > Date.parse(cloudSchedule.last_reviewed_at))) {
      return refuse("attempt_not_newer_than_cloud");
    }

    const next = computeNextSchedule(
      { streak: cloud.schedule.streak, lapseCount: cloud.schedule.lapse_count },
      original.result,
      new Date(original.reviewed_at)
    );
    const rebased: RecordGradedAttemptRpcInput = {
      ...base,
      expected_schedule: cloudSchedule,
      schedule: {
        due_at: next.dueAt,
        interval_days: next.intervalDays,
        streak: next.streak,
        lapse_count: next.lapseCount,
      },
      item_status: deriveItemStatus(cloud.item, cloud.schedules, original.ability, next.status),
    };

    try {
      appendRebaseJournal(userId, {
        id: generateId("rebasej"),
        createdAt: nowIso(),
        kind: "record_graded_attempt",
        sessionId: original.session_id,
        exerciseId: original.exercise_id,
        outboxEntryId: entry.id,
        canonicalItemId: alias.canonicalId,
        ability: original.ability,
        localExpected: original.expected_schedule,
        localAfter: { ...original.schedule, last_reviewed_at: original.reviewed_at },
        cloudBefore: cloudSchedule,
        cloudAfter: { ...rebased.schedule, last_reviewed_at: original.reviewed_at },
        originalPayload: original,
      });
    } catch {
      return refuse("journal_write_failed");
    }

    const response = await supabase.rpc("record_graded_attempt", { payload: rebased });
    if (!response.error) return { kind: "applied" };
    if (isScheduleChanged(response.error)) continue; // 重放期間雲端又變動：重讀、重算，不關 CAS。
    return { kind: "error", status: response.status ?? 0, message: response.error.message };
  }
  return refuse("cloud_schedule_kept_changing");
}

// ---------------------------------------------------------------------------
// mark_attempt_correct：payload 沒有 learning_item_id，由重放 journal＋雲端作答列反查
// ---------------------------------------------------------------------------

async function rebaseMark(
  supabase: SupabaseClient,
  userId: string,
  entry: OutboxEntry & { type: "mark_attempt_correct" }
): Promise<RebaseOutcome> {
  const original = entry.payload;
  const aliases = safeAliases(userId);
  if (!aliases) return refuse("alias_unreadable");

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const journal = safeJournal(userId);
    if (!journal) return refuse("journal_unreadable");
    const recorded = latestJournal(journal, "record_graded_attempt", original.session_id, original.exercise_id);
    if (!recorded) return refuse("no_rebase_record_for_correction");

    const alias = aliases.items.find((candidate) => candidate.canonicalId === recorded.canonicalItemId);
    if (!alias) return refuse("no_alias");

    const read = await readCloud(supabase, userId, recorded.canonicalItemId, recorded.ability, original.session_id, original.exercise_id);
    if (!read.ok) return { kind: "error", status: read.status, message: read.message };
    const cloud = read.value;

    if (!cloud.attempt) return refuse("attempt_missing_in_cloud");
    if (
      cloud.attempt.learning_item_id !== recorded.canonicalItemId ||
      abilityForExerciseType(cloud.attempt.exercise_type) !== recorded.ability
    ) {
      return refuse("attempt_differs");
    }
    if (!cloud.item) return refuse("cloud_item_missing");
    if (!cloud.schedule) return refuse("cloud_schedule_missing");
    if (!localItemCompatible(userId, alias.localId, cloud.item)) return refuse("fields_incompatible");
    if (!scheduleEquals(recorded.localAfter, original.expected_schedule)) return refuse("unproven_expected_schedule");

    // 從「重放前的雲端位置」重算 correct，與本機 markAttemptCorrect 的推導等價。
    const target = computeNextSchedule(
      { streak: recorded.cloudBefore.streak, lapseCount: recorded.cloudBefore.lapse_count },
      "correct",
      new Date(cloud.attempt.reviewed_at)
    );
    const targetSchedule: ExpectedScheduleState = {
      due_at: target.dueAt,
      interval_days: target.intervalDays,
      streak: target.streak,
      lapse_count: target.lapseCount,
      last_reviewed_at: cloud.attempt.reviewed_at,
    };

    const cloudSchedule = rowToSnapshot(cloud.schedule);
    if (cloud.attempt.result === "correct") {
      return scheduleEquals(cloudSchedule, targetSchedule) ? { kind: "already_applied" } : refuse("correction_state_mismatch");
    }
    if (!scheduleEquals(cloudSchedule, recorded.cloudAfter)) return refuse("cloud_schedule_changed_since_replay");

    const rebased: MarkAttemptCorrectRpcInput = {
      session_id: original.session_id,
      exercise_id: original.exercise_id,
      expected_schedule: cloudSchedule,
      schedule: {
        due_at: target.dueAt,
        interval_days: target.intervalDays,
        streak: target.streak,
        lapse_count: target.lapseCount,
      },
      item_status: deriveItemStatus(cloud.item, cloud.schedules, recorded.ability, target.status),
    };

    try {
      appendRebaseJournal(userId, {
        id: generateId("rebasej"),
        createdAt: nowIso(),
        kind: "mark_attempt_correct",
        sessionId: original.session_id,
        exerciseId: original.exercise_id,
        outboxEntryId: entry.id,
        canonicalItemId: recorded.canonicalItemId,
        ability: recorded.ability,
        localExpected: original.expected_schedule,
        localAfter: { ...original.schedule, last_reviewed_at: recorded.localAfter.last_reviewed_at },
        cloudBefore: cloudSchedule,
        cloudAfter: targetSchedule,
        originalPayload: original,
      });
    } catch {
      return refuse("journal_write_failed");
    }

    const response = await supabase.rpc("mark_attempt_correct", { payload: rebased });
    if (!response.error) return { kind: "applied" };
    if (isScheduleChanged(response.error)) continue;
    return { kind: "error", status: response.status ?? 0, message: response.error.message };
  }
  return refuse("cloud_schedule_kept_changing");
}

// ---------------------------------------------------------------------------
// 對外入口
// ---------------------------------------------------------------------------

/** 首筆 record／mark 回 `schedule_changed` 時呼叫；其他型別一律拒絕，不做任何事。 */
export async function rebaseScheduleConflict(
  supabase: SupabaseClient,
  userId: string,
  entry: OutboxEntry
): Promise<RebaseOutcome> {
  if (entry.type === "record_graded_attempt") return rebaseRecord(supabase, userId, entry);
  if (entry.type === "mark_attempt_correct") return rebaseMark(supabase, userId, entry);
  return refuse("no_rebase_record_for_correction");
}

/**
 * 送出前呼叫：若這筆 entry 先前已重放過（journal 有紀錄），且雲端已經有相同結果，代表上一次
 * RPC 成功但本機來不及移除 entry——回傳 already_applied，呼叫端直接移除，不重複作答。
 * 沒有 journal、或雲端還沒有結果時回傳 proceed，走正常送出流程。
 */
export async function checkAlreadyApplied(
  supabase: SupabaseClient,
  userId: string,
  entry: OutboxEntry
): Promise<RebaseOutcome> {
  if (entry.type !== "record_graded_attempt" && entry.type !== "mark_attempt_correct") return { kind: "proceed" };
  const journal = safeJournal(userId);
  if (!journal) return { kind: "proceed" };
  const sessionId = entry.payload.session_id;
  const exerciseId = entry.payload.exercise_id;
  const intent = latestJournal(journal, entry.type, sessionId, exerciseId);
  if (!intent) return { kind: "proceed" };

  const read = await readCloud(supabase, userId, intent.canonicalItemId, intent.ability, sessionId, exerciseId);
  if (!read.ok) return { kind: "error", status: read.status, message: read.message };
  const { attempt, schedule } = read.value;
  if (!attempt) return { kind: "proceed" };

  if (entry.type === "record_graded_attempt") {
    const aliases = safeAliases(userId);
    if (!aliases) return refuse("alias_unreadable");
    const translated = translateOutgoingOperation(entry, aliases);
    if (translated.type !== "record_graded_attempt") return { kind: "proceed" };
    return sameAttempt(attempt, translated.payload) ? { kind: "already_applied" } : refuse("attempt_differs");
  }
  if (attempt.result === "correct" && schedule && scheduleEquals(rowToSnapshot(schedule), intent.cloudAfter)) {
    return { kind: "already_applied" };
  }
  return { kind: "proceed" };
}

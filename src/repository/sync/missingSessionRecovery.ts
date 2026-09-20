/**
 * 補送「本機有、雲端沒有」的 study_session，讓已經卡在 outbox 的作答可以重試。
 *
 * 背景：作答 RPC（`record_graded_attempt`）要求雲端已經有對應的 session 列。如果那個
 * session 是在「沒有 outbox 的純本機 repository」下建立的（冷啟動時 auth 尚未 resolve、
 * 或登入前就開始的 session 之後被 `/study` 直接恢復），雲端永遠不會有這一列，作答就會
 * 一直失敗在 `record_graded_attempt: session "…" 不存在`。它是 FIFO 首筆，整個佇列跟著
 * 停擺——這正是手機上觀察到的狀態。
 *
 * 這裡補的不是憑空捏造的資料：plannedUnits／new_item_ids／review_item_ids／started_at
 * 全部來自本機真實存在的那筆 session。唯一刻意不照抄的是 `status`／`completed_at`——
 * 必須還原成「這些待送作答發生之前」的 in_progress 狀態，否則直接回填本機最終
 * （可能已 completed）狀態後，後續重播會撞上伺服器的「session 已經是 completed，不能
 * 再評分」，或是讓雲端跳過真正的完成時間點。完成與放棄由後面原本就排在佇列裡的操作
 * （最後一筆作答帶 session_completed、或 abandon_session）依序達成。
 *
 * 安全前提（任何一項不成立都 refused，outbox 原封不動、fail closed）：
 * 1. 雲端確實沒有這個 session（用一般登入使用者權限查詢；查得到就不是這個問題）。
 * 2. 本機有這筆 session，且 plannedUnits 非空。
 * 3. 雲端沒有這個 session 的任何作答紀錄（有的話代表資料狀態超出這裡能安全推理的範圍）。
 * 3b. session 引用的每個項目都是目前登入帳戶自己的雲端項目——換帳戶後殘留的別人待送
 *     作答，本來就靠「這個帳戶沒有這個 session」被擋下，補送不能把這道保護拆掉。
 * 4. outbox 裡屬於這個 session 的待送作答，筆數等於本機 `exerciseResults` 筆數，且逐筆
 *    對得上 `plannedUnits[i]`／`exerciseResults[i]`——也就是「第 0 題開始、連續、沒有
 *    任何一筆已經遺失」。伺服器用 `count(review_attempts)` 推導 sequence 並核對
 *    plannedUnits 位置，前面缺一筆就會把後面的作答寫到錯的位置，所以這裡寧可拒絕。
 *
 * 本模組不移除、不改寫任何 outbox entry；補上 session 之後由呼叫端用原本那一筆重試。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { readPersistedStore } from "../schema";
import { loadAliasStore, resolveCanonicalItemId, translateOutgoingOperation } from "./alias";
import { listOutboxEntries, studySessionToRow, type OutboxEntry, type RecordGradedAttemptRpcInput } from "./outbox";

export type MissingSessionRefusal =
  | "local_session_missing"
  | "local_session_empty"
  | "cloud_attempts_present"
  | "cloud_items_missing"
  | "pending_attempt_count_mismatch"
  | "pending_attempt_order_mismatch";

export type MissingSessionOutcome =
  /** 已經把 session 補上雲端；呼叫端應該用同一筆 outbox entry 重試。 */
  | { kind: "restored" }
  /** 不是「雲端缺 session」這個問題，呼叫端照原本的錯誤處理走。 */
  | { kind: "not_applicable" }
  | { kind: "refused"; reason: MissingSessionRefusal; detail: string }
  | { kind: "error"; status: number; message: string };

function pendingAttemptsForSession(sessionId: string): RecordGradedAttemptRpcInput[] {
  return listOutboxEntries()
    .filter(
      (entry): entry is OutboxEntry & { type: "record_graded_attempt" } =>
        entry.type === "record_graded_attempt" && entry.payload.session_id === sessionId
    )
    .map((entry) => entry.payload);
}

export async function restoreMissingCloudSession(
  supabase: SupabaseClient,
  userId: string,
  entry: OutboxEntry
): Promise<MissingSessionOutcome> {
  if (entry.type !== "record_graded_attempt") return { kind: "not_applicable" };
  const sessionId = entry.payload.session_id;

  const cloudSession = await supabase
    .from("study_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("id", sessionId)
    .maybeSingle();
  if (cloudSession.error) {
    return { kind: "error", status: cloudSession.status, message: cloudSession.error.message };
  }
  if (cloudSession.data) return { kind: "not_applicable" };

  const session = readPersistedStore().studySessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    return { kind: "refused", reason: "local_session_missing", detail: `本機找不到 session ${sessionId}` };
  }
  if (session.plannedUnits.length === 0) {
    return { kind: "refused", reason: "local_session_empty", detail: `session ${sessionId} 沒有題目順序可以重建` };
  }

  const cloudAttempts = await supabase
    .from("review_attempts")
    .select("id")
    .eq("user_id", userId)
    .eq("session_id", sessionId);
  if (cloudAttempts.error) {
    return { kind: "error", status: cloudAttempts.status, message: cloudAttempts.error.message };
  }
  const cloudAttemptCount = (cloudAttempts.data ?? []).length;
  if (cloudAttemptCount > 0) {
    return {
      kind: "refused",
      reason: "cloud_attempts_present",
      detail: `雲端沒有 session 卻已經有 ${cloudAttemptCount} 筆作答，不自動推理`,
    };
  }

  // 跨帳戶保護：outbox 是整個瀏覽器共用一份，換帳戶登入時可能還留著前一個帳戶的待送作答。
  // 那些作答本來就會因為「這個帳戶底下沒有這個 session」而被伺服器擋下——補送 session 會
  // 把這道保護拆掉，把別人的學習紀錄寫進目前帳戶。所以補送前要求：這個 session 引用的每個
  // 項目，都必須是目前登入帳戶自己在雲端已有的項目（RLS 之下查得到）。作答 RPC 本來也要求
  // 項目存在，所以查不到時補送 session 也沒有意義。
  const aliases = loadAliasStore(userId);
  const ownedItems = await supabase.from("learning_items").select("id").eq("user_id", userId);
  if (ownedItems.error) {
    return { kind: "error", status: ownedItems.status, message: ownedItems.error.message };
  }
  const ownedItemIds = new Set(((ownedItems.data ?? []) as Array<{ id: string }>).map((row) => row.id));
  const missingItemIds = session.plannedUnits
    .map((unit) => resolveCanonicalItemId(aliases, unit.learningItemId))
    .filter((itemId) => !ownedItemIds.has(itemId));
  if (missingItemIds.length > 0) {
    return {
      kind: "refused",
      reason: "cloud_items_missing",
      detail: `目前帳戶雲端沒有這個 session 引用的 ${missingItemIds.length} 個項目（例如 ${missingItemIds[0]}）`,
    };
  }

  const pending = pendingAttemptsForSession(sessionId);
  if (pending.length !== session.exerciseResults.length) {
    return {
      kind: "refused",
      reason: "pending_attempt_count_mismatch",
      detail: `本機已作答 ${session.exerciseResults.length} 筆，outbox 只剩 ${pending.length} 筆待送，缺口無法安全補齊`,
    };
  }
  for (let index = 0; index < pending.length; index += 1) {
    const unit = session.plannedUnits[index];
    const recorded = session.exerciseResults[index];
    const payload = pending[index];
    if (
      !unit ||
      !recorded ||
      unit.learningItemId !== payload.learning_item_id ||
      unit.ability !== payload.ability ||
      recorded.exerciseId !== payload.exercise_id
    ) {
      return {
        kind: "refused",
        reason: "pending_attempt_order_mismatch",
        detail: `第 ${index} 筆待送作答與本機 session 的題目順序對不上`,
      };
    }
  }

  // 還原成「這些待送作答發生之前」的狀態，見檔案開頭說明。
  const row = studySessionToRow({ ...session, status: "in_progress", completedAt: undefined }, userId);
  const operation = translateOutgoingOperation({ type: "upsert_session", payload: row }, aliases);
  const inserted = await supabase.rpc("upsert_study_session_guarded", { payload: operation.payload });
  if (inserted.error) {
    return { kind: "error", status: inserted.status, message: inserted.error.message };
  }
  return { kind: "restored" };
}

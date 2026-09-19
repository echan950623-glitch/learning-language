/**
 * 跨裝置「相同單字、不同 id」衝突的**判定**邏輯（純函式，不做任何網路或 localStorage I/O，
 * 方便完整單元測試）。實際協調 Supabase 查詢／別名 journal 寫入的邏輯在 `syncEngine.ts` 的
 * `resolveContentKeyConflict`；別名／journal 的儲存本身在 `alias.ts`。
 *
 * 背景：`learning_items` 有 `unique(user_id, content_key)`（見
 * `supabase/migrations/20260916010000_cloud_sync_tables.sql`）。兩台裝置各自離線建立同一個
 * 單字時，本機各自產生不同的 `id`（`generateId()` 是隨機的），但 `content_key`
 * （language+type+promptZh+answer+reading）相同。先同步的那台裝置的 `id` 會成功寫進
 * `learning_items`；另一台裝置之後才送出的 guarded insert 不會跟它自己的 `id` 衝突，
 * 而是跟 unique(user_id, content_key) 衝突。
 *
 * 2026-09-19（bounded sync safety revision）修正：**不再自動選邊**。舊版遇到這種衝突會
 * 直接把「輸家」id 全面改寫成「贏家」id，並且對排程用「比較新／比較有進度」規則自動選一邊、
 * 丟棄另一邊還沒送出的操作——這正是被 review 指出的核心問題：排程分歧時選新的那筆，等於
 * 靜默丟掉另一台裝置的真實學習歷史，而且「比較新」本身無法證明沒有遺失資料。
 *
 * 新規則（`decideContentKeyConflict`）：
 * - 只有「本機與遠端的欄位完全相容（沒有兩邊都非空但不同的說明／羅馬拼音／詞性／例句／
 *   狀態）」**且**「不是兩邊都各自有排程／作答／session 引用」時，才自動建立別名
 *   （`auto_alias`）。若只有一邊有進度，另一邊只是同內容、不同隨機 ID 的全新副本，把空白
 *   那邊對應到有進度的 canonical id 不會覆蓋或丟棄任何學習紀錄。
 * - 其餘情況一律回傳 `unresolved_conflict`：不猜測合併，也不自動選邊，由呼叫端把完整的
 *   雙邊快照存成一筆持久化的「未解決衝突」記錄（`alias.ts` 的 `recordUnresolvedItemConflict`），
 *   並讓這筆 `upsert_item` 留在 outbox 最前面（不移除、不 remap）——後面所有操作因此自然
 *   暫停在這裡（fail-closed），不會有任何一邊的資料被丟棄或覆蓋，直到有伺服器端的原子
 *   保護機制或人工介入才能真正合併。
 */

import type { ConflictReason } from "./alias";
import type { LearningItemRow } from "./outbox";

// ---------------------------------------------------------------------------
// 衝突偵測：只認 learning_items 的 (user_id, content_key) 唯一鍵衝突，不誤判其他 23505。
// ---------------------------------------------------------------------------

/** Postgres unique_violation 的 SQLSTATE。 */
export const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface SupabaseErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export function isContentKeyConflict(error: SupabaseErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (error.code !== POSTGRES_UNIQUE_VIOLATION) return false;
  const haystack = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return haystack.includes("content_key");
}

// ---------------------------------------------------------------------------
// LearningItem 欄位合併：只填補遠端缺的欄位／聯集 tags／狀態只允許從 'new' 升級，
// 絕不覆蓋遠端既有的非空值——「不覆蓋或遺失既有進度」的第一道防線，只用在
// `decideContentKeyConflict` 已經判定 `auto_alias`（欄位相容）之後的實際補寫。
// ---------------------------------------------------------------------------

const FILLABLE_TEXT_FIELDS = ["explanation", "romaji", "part_of_speech", "example_sentence"] as const;

/** 回傳需要補寫到遠端「贏家」列的欄位；完全不需要變更時回傳 null。 */
export function mergeLearningItemPatch(
  remote: LearningItemRow,
  local: LearningItemRow
): Partial<LearningItemRow> | null {
  const patch: Partial<LearningItemRow> = {};

  for (const key of FILLABLE_TEXT_FIELDS) {
    if (!remote[key] && local[key]) {
      patch[key] = local[key];
    }
  }

  const mergedTags = Array.from(new Set([...remote.tags, ...local.tags]));
  if (mergedTags.length !== remote.tags.length) {
    patch.tags = mergedTags;
  }

  // 狀態只允許從 'new'（遠端那個身分完全沒學過）升級成本機已有的進度；遠端只要不是
  // 'new'，代表遠端自己已經有實際進度，本機這份「輸家」絕不會覆蓋它。
  if (remote.status === "new" && local.status !== "new") {
    patch.status = local.status;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

// ---------------------------------------------------------------------------
// 欄位相容性判定：「雙方都非空但不同」才算真的衝突；其中一邊是空值（可以補）或兩邊
// 相同都不算——跟 mergeLearningItemPatch 的「只填空、絕不覆蓋非空值」是同一套判準，
// 只是這裡回傳的是「能不能自動處理」的布林判斷本身，給 `decideContentKeyConflict` 使用。
// ---------------------------------------------------------------------------

export type FieldCompatibility = { compatible: true } | { compatible: false; conflictingFields: string[] };

export function checkItemFieldsCompatible(remote: LearningItemRow, local: LearningItemRow): FieldCompatibility {
  const conflictingFields: string[] = [];
  for (const key of FILLABLE_TEXT_FIELDS) {
    if (remote[key] && local[key] && remote[key] !== local[key]) {
      conflictingFields.push(key);
    }
  }
  if (remote.status !== "new" && local.status !== "new" && remote.status !== local.status) {
    conflictingFields.push("status");
  }
  if (remote.source !== local.source) conflictingFields.push("source");
  if (remote.is_seed !== local.is_seed) conflictingFields.push("is_seed");
  return conflictingFields.length > 0 ? { compatible: false, conflictingFields } : { compatible: true };
}

// ---------------------------------------------------------------------------
// 最終決策：欄位相容，而且不是雙邊都各自有進度，才自動建立別名。
// ---------------------------------------------------------------------------

export type ConflictDecision =
  | { kind: "auto_alias" }
  | { kind: "unresolved_conflict"; reason: ConflictReason; detail: string };

export function decideContentKeyConflict(params: {
  fieldCompatibility: FieldCompatibility;
  localHasProgress: boolean;
  remoteHasProgress: boolean;
}): ConflictDecision {
  if (!params.fieldCompatibility.compatible) {
    return {
      kind: "unresolved_conflict",
      reason: "fields_incompatible",
      detail: `這個單字的欄位內容跟雲端已有的版本不相容（${params.fieldCompatibility.conflictingFields.join("、")}），無法自動合併，需要人工確認。`,
    };
  }
  if (params.localHasProgress && params.remoteHasProgress) {
    return {
      kind: "unresolved_conflict",
      reason: "both_sides_have_progress",
      detail: "本機與雲端的同內容單字都各自有排程、作答或 session 引用；在能證明合併不會蓋掉任何一邊之前，暫不自動合併。",
    };
  }
  return { kind: "auto_alias" };
}
